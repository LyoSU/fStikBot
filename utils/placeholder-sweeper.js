// Removes bootstrap placeholders the add path never got to.
//
// The placeholder (scenes/pack-new.js) is removed when the bot adds the first
// real sticker. Prod 2026-11-18: of packs created 2–9 days earlier, ~6% of
// those still marked held the placeholder next to real stickers — all with no
// sticker rows in our DB, i.e. filled straight from a Telegram app, where the
// bot never hears about the add. A failed delete (Telegram 5xx) also waited
// for a next add that might never come.
//
// Each pack with a pending placeholder carries `placeholderCheckAt`; this
// worker takes due packs a batch at a time, looks at the set and removes the
// placeholder once a real sticker is there (utils/placeholder-schedule.js has
// the timing). It never deletes the last sticker of a set.
//
// It takes the pack's lock, the one a Studio publish holds (pack-ops), so it
// never deletes a sticker under a running publish: the executor would see the
// pack change mid-way and fail the job as "changed outside". A pack that is
// busy is looked at again a little later.
const { removePlaceholderIfPending } = require('./placeholder')
const { nextPlaceholderCheck, CHECK_DELAYS_MS, RETRY_AFTER_ERROR_MS } = require('./placeholder-schedule')
const { isTransientError } = require('./transient-error')

const TICK_INTERVAL_MS = parseInt(process.env.PLACEHOLDER_SWEEP_INTERVAL_MS, 10) || 60 * 1000
const BATCH = parseInt(process.env.PLACEHOLDER_SWEEP_BATCH, 10) || 60
// Space getStickerSet calls out; the sweep is never in a hurry.
const GAP_MS = 150
// Long enough for one getStickerSet + deleteStickerFromSet.
const LOCK_TTL_MS = 60 * 1000

// Telegram no longer has the set: nothing left to clean.
const isGone = (error) => /STICKERSET_INVALID|STICKERSET_NOT_FOUND/i.test(error?.description || error?.message || '')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {Object} deps
 * @param {Object} deps.repo       due(now, limit) / reschedule(pack, at, checks) / clear(pack)
 * @param {Object} deps.telegram   getStickerSet + callApi
 * @param {Object} [deps.lock]     acquire(name, ttl) / release(name, token): the pack-ops lock
 */
function createPlaceholderSweeper ({
  repo,
  telegram,
  removePlaceholder = removePlaceholderIfPending,
  now = () => Date.now(),
  batch = BATCH,
  gapMs = GAP_MS,
  lock = null,
  log = console
}) {
  let timer = null
  let active = null
  let stopping = false

  // One pack, under its lock. Returns what happened, for tests and the
  // tick's summary.
  async function checkOne (pack) {
    if (!lock) return look(pack)
    const token = await lock.acquire(pack.name, LOCK_TTL_MS)
    if (!token) {
      // A publish is running on it: soon again, without using up a look.
      await repo.reschedule(pack, new Date(now() + RETRY_AFTER_ERROR_MS), pack.placeholderChecks || 0)
      return 'busy'
    }
    try {
      return await look(pack)
    } finally {
      await lock.release(pack.name, token).catch(() => {})
    }
  }

  async function look (pack) {
    const checks = pack.placeholderChecks || 0

    let set
    try {
      set = await telegram.getStickerSet(pack.name)
    } catch (error) {
      if (isGone(error)) {
        await repo.clear(pack)
        return 'gone'
      }
      // A Telegram hiccup says nothing about the pack: look again soon,
      // without using up one of its looks.
      await repo.reschedule(pack, new Date(now() + RETRY_AFTER_ERROR_MS), checks)
      return isTransientError(error) ? 'error' : 'refused'
    }

    // Clears the marker and the schedule itself when it resolves.
    if (await removePlaceholder(telegram, pack, set)) return 'resolved'

    // Real stickers are there but the delete failed (a long 429, or a refusal
    // that will repeat): soon again, and it counts as a look so a delete that
    // can never succeed doesn't keep the pack in the sweep forever.
    if ((set.stickers || []).length >= 2) {
      const more = checks + 1 < CHECK_DELAYS_MS.length
      await repo.reschedule(pack, more ? new Date(now() + RETRY_AFTER_ERROR_MS) : null, checks + 1)
      return 'retry'
    }

    // Still only the placeholder: the next look, or none.
    await repo.reschedule(pack, nextPlaceholderCheck(checks + 1, now()), checks + 1)
    return 'waiting'
  }

  async function tick () {
    if (active || stopping) return active
    active = (async () => {
      const packs = await repo.due(new Date(now()), batch)
      const outcome = {}
      for (const pack of packs) {
        if (stopping) break
        const result = await checkOne(pack).catch((error) => {
          log.warn(`placeholder sweep failed for ${pack.name}:`, error?.message || error)
          return 'failed'
        })
        outcome[result] = (outcome[result] || 0) + 1
        if (gapMs) await sleep(gapMs)
      }
      if (outcome.resolved || outcome.gone || outcome.failed) {
        log.info(`placeholder sweep: ${Object.entries(outcome).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      }
      return outcome
    })().catch((error) => {
      log.warn('placeholder sweep tick failed:', error?.message || error)
    }).finally(() => { active = null })
    return active
  }

  function start () {
    if (timer) return
    stopping = false
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (active) await active
  }

  return { start, stop, tick, checkOne }
}

// The real repo over the StickerSet model. `due` returns full documents:
// removePlaceholderIfPending saves through them.
const mongoRepo = (db) => ({
  due: (at, limit) => db.StickerSet.find({ placeholderCheckAt: { $lte: at } })
    .sort({ placeholderCheckAt: 1 })
    .limit(limit)
    .select('_id name placeholderFileUniqueId placeholderCheckAt placeholderChecks'),

  reschedule: (pack, at, checks) => db.StickerSet.updateOne({ _id: pack._id }, at
    ? { $set: { placeholderCheckAt: at, placeholderChecks: checks } }
    // Out of looks: leave the marker for the add path, stop sweeping.
    : { $unset: { placeholderCheckAt: '', placeholderChecks: '' } }),

  clear: (pack) => db.StickerSet.updateOne({ _id: pack._id }, {
    $unset: { placeholderFileUniqueId: '', placeholderCheckAt: '', placeholderChecks: '' }
  })
})

let instance = null

// autoIndex is off: without its index the sweep's query would scan the whole
// stickersets collection every minute. Start only once
// scripts/ensure-indexes.js has created it.
const hasQueueIndex = async (db) => {
  const indexes = await db.StickerSet.collection.indexes()
  return indexes.some((index) => Object.keys(index.key).join() === 'placeholderCheckAt')
}

async function start () {
  if (instance) return
  const { db } = require('../database')
  const telegram = require('./telegram')
  const log = require('./logger').scope('placeholder-sweeper')

  await db.connection.asPromise()
  if (!await hasQueueIndex(db).catch(() => false)) {
    log.warn('not started: index on stickersets.placeholderCheckAt is missing — run scripts/ensure-indexes.js')
    return
  }
  if (instance) return
  const { mongoLock } = require('../pack-ops/store')
  instance = createPlaceholderSweeper({ repo: mongoRepo(db), telegram, lock: mongoLock(db), log })
  instance.start()
  log.info('started')
}

async function stop () {
  if (instance) await instance.stop()
}

module.exports = { createPlaceholderSweeper, mongoRepo, start, stop, TICK_INTERVAL_MS }
