// Studio publish worker. The API queues a commit (a draft of a pack plus the
// files it needs, stored as studioassets); this picks it up and carries it
// through, one commit at a time per process:
//
//   queued → preparing   upload the draft's files to Telegram
//          → pending     publishCommit (pack-ops/execute.js) runs it
//          → succeeded   then the bot's own sticker docs are synced
//
// Several bot processes may run it side by side: the claim is one atomic
// update, the publish takes the pack lock, and the sync is idempotent.
// See pack-ops/README.md.

const { runInCopyScope } = require('../utils/retry-api')
const { LOCK_TTL_MS } = require('./execute')
const { bytesOf } = require('./store')
const log = require('../utils/logger').scope('pack-ops:worker')

const TICK_INTERVAL_MS = parseInt(process.env.STUDIO_TICK_INTERVAL_MS, 10) || 2000
// A `preparing` claim older than this is a dead process's. Uploads refresh it.
const CLAIM_STALE_MS = 2 * 60 * 1000
const CLAIM_HEARTBEAT_MS = 30 * 1000
// A failing sync is retried after 10 s, 20 s, 40 s … up to 10 min, and given up
// after this many tries (synced stays false, syncError says why).
const SYNC_MAX_ATTEMPTS = 10
const syncBackoffMs = (attempts) => Math.min(2 ** attempts * 5000, 10 * 60 * 1000)

// Same split as the executor: an answer from Telegram is final, anything else
// (a timeout, a reset connection) says nothing about what Telegram did.
const errorCode = (err) => err?.code ?? err?.response?.error_code
const errorText = (err) => err?.description || err?.response?.description || err?.message || String(err)
const formatOf = (sticker) => (sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static')
const isRefusal = (err) => Number.isInteger(errorCode(err)) && errorCode(err) >= 400 && errorCode(err) < 500 && errorCode(err) !== 429

/**
 * @param {Object} deps
 * @param {Object} deps.repo database access (worker-repo.js)
 * @param {{save: Function}} deps.store commit persistence (store.js)
 * @param {{callApi: Function}} deps.telegram
 * @param {Function} deps.publish (commitId) => commit, runs a pending commit
 * @param {Function} [deps.now]
 */
function createWorker ({ repo, store, telegram, publish, now = () => new Date() }) {
  let timer = null
  let active = null
  let stopping = false

  const uploadsOf = (commit) => commit.draft.filter((item) => item.file)

  // A sticker copied from another set goes in by the file_id this bot is
  // given for it: the API reads sets with a token of its own, and a file_id is
  // only good for the bot it was issued to. file_unique_id is the same for both.
  async function copiedSticker (sets, copy) {
    if (!sets.has(copy.set)) {
      const set = await runInCopyScope(() => telegram.callApi('getStickerSet', { name: copy.set }))
        .catch((err) => {
          if (isRefusal(err)) return { stickers: [] }
          throw err
        })
      sets.set(copy.set, set)
    }
    return sets.get(copy.set).stickers.find((sticker) => sticker.file_unique_id === copy.fileUniqueId)
  }

  // Uploads every file the draft still lacks a file_id for, saving the commit
  // after each so a crash resumes with the rest. Returns the commit with its
  // new status.
  async function prepare (commit) {
    const heartbeat = setInterval(() => {
      repo.touchClaim(commit._id, now()).catch((err) => log.warn('claim heartbeat failed:', err.message))
    }, CLAIM_HEARTBEAT_MS)
    heartbeat.unref()

    const settle = async (status, error = null) => {
      commit.status = status
      commit.error = error
      commit.updatedAt = now()
      await store.save(commit)
      return commit
    }

    const sets = new Map()

    try {
      for (const item of uploadsOf(commit)) {
        if (item.file.fileId) continue

        if (item.file.copy) {
          const sticker = await copiedSticker(sets, item.file.copy)
          if (!sticker) return await settle('failed', 'copy_missing')
          item.file.fileId = sticker.file_id
          item.file.format = formatOf(sticker)
          commit.updatedAt = now()
          await store.save(commit)
          continue
        }

        const asset = await repo.loadAsset(item.file.studioAssetId)
        if (!asset) return await settle('failed', 'asset_missing')

        // A file_id from an earlier attempt, if it was made for this owner.
        let fileId = asset.fileId && asset.fileOwner === commit.ownerTelegramId ? asset.fileId : null
        if (!fileId) {
          const uploaded = await runInCopyScope(() => telegram.callApi('uploadStickerFile', {
            user_id: commit.ownerTelegramId,
            sticker: { source: bytesOf(asset.data) },
            sticker_format: item.file.format || asset.format
          }))
          fileId = uploaded.file_id
          await repo.setAssetFileId(asset._id, fileId, commit.ownerTelegramId)
        }

        item.file.fileId = fileId
        commit.claimedAt = now()
        commit.updatedAt = now()
        await store.save(commit)
      }
      return await settle('pending')
    } catch (err) {
      log.warn(`commit ${commit._id} preparing stopped:`, errorText(err))
      return settle(isRefusal(err) ? 'failed' : 'interrupted', errorText(err))
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Makes the bot's sticker docs match the pack as published. Reads the pack
  // back from Telegram rather than trusting the commit: file_ids and the final
  // order are Telegram's.
  async function sync (commit) {
    const pack = await repo.findPack(commit)
    if (!pack) {
      log.warn(`commit ${commit._id}: pack ${commit.name} is not in the database, nothing to sync`)
      return repo.markSynced(commit._id)
    }

    // A deleted set: the bot's records say so, as after its own "Delete pack".
    if (commit.remove) {
      await repo.writeRemoved(pack, now())
      await repo.markSynced(commit._id)
      log.info(`commit ${commit._id}: ${commit.name} deleted`)
      return
    }

    const set = await telegram.callApi('getStickerSet', { name: commit.name })
    const inPack = new Map(set.stickers.map((s) => [s.file_unique_id, s]))

    const stickers = []
    for (const item of commit.draft) {
      const sticker = inPack.get(commit.mapping?.[item.assetId])
      if (!sticker) continue
      stickers.push({
        fileUniqueId: sticker.file_unique_id,
        fileId: sticker.file_id,
        emojiList: item.emojiList,
        keywords: item.keywords
      })
    }

    const live = await repo.liveStickerUids(pack._id)
    await repo.writeSync(pack._id, {
      stickers,
      deletedUids: live.filter((uid) => !inPack.has(uid)),
      clearPlaceholder: !!pack.placeholderFileUniqueId && !inPack.has(pack.placeholderFileUniqueId),
      // The title as Telegram has it, suffix and all.
      title: commit.settings?.title !== undefined ? set.title : undefined
    }, now())
    await repo.markSynced(commit._id)
    log.info(`commit ${commit._id}: synced ${stickers.length} stickers of ${commit.name}`)
  }

  // A sync that fails is scheduled again later instead of retried every tick.
  async function trySync (commit) {
    try {
      await sync(commit)
    } catch (err) {
      const attempts = (commit.syncAttempts || 0) + 1
      const after = new Date(now().getTime() + syncBackoffMs(attempts))
      await repo.recordSyncFailure(commit._id, { attempts, after, error: errorText(err) })
      const outcome = attempts >= SYNC_MAX_ATTEMPTS ? 'giving up' : `retrying after ${after.toISOString()}`
      log.warn(`commit ${commit._id}: sync failed (attempt ${attempts}), ${outcome}:`, errorText(err))
    }
  }

  // A copy into another pack type is paid for when the API takes it. A commit
  // that ends without making the pack gives the credit back, as the /new
  // wizard does when its copy fails.
  async function refundIfUnmade (commit) {
    const { charge } = commit || {}
    if (!charge?.credits || charge.refunded) return
    if (commit.status !== 'failed' && commit.status !== 'conflict') return
    if (commit.create && ['created', 'done'].includes(commit.create.state)) return

    try {
      if (await repo.refundCharge(commit._id, charge)) log.info(`commit ${commit._id}: ${charge.credits} credit(s) refunded`)
      charge.refunded = true
    } catch (err) {
      log.error(`commit ${commit._id}: refund failed:`, errorText(err))
    }
  }

  async function run (commit) {
    const result = await publish(commit._id)
    if (result?.status === 'succeeded') await trySync(result)
    else await refundIfUnmade(result)
    return result
  }

  // One unit of work. Returns false when there was nothing to do.
  async function step () {
    const claimed = await repo.claimForPrepare(now(), CLAIM_STALE_MS)
    if (claimed) {
      const prepared = await prepare(claimed)
      if (prepared.status === 'pending') await run(prepared)
      else await refundIfUnmade(prepared)
      return true
    }

    const runnable = await repo.findRunnable(now(), LOCK_TTL_MS)
    if (runnable) {
      await run(runnable)
      return true
    }

    // Last, so a commit whose sync keeps failing doesn't hold up the others.
    const unsynced = await repo.findUnsynced(now(), SYNC_MAX_ATTEMPTS)
    if (unsynced) {
      await trySync(unsynced)
      return true
    }
    return false
  }

  async function tick () {
    if (active || stopping) return
    active = (async () => {
      try {
        // Keep going while there is work: no need to wait a tick between commits.
        let worked
        do {
          worked = !stopping && await step()
        } while (worked)
      } catch (err) {
        log.error('tick failed:', err.stack || err.message)
      } finally {
        active = null
      }
    })()
    await active
  }

  function start () {
    if (timer) return
    log.info(`studio worker started (interval=${TICK_INTERVAL_MS}ms)`)
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  // Lets the commit in hand finish its current run (it is resumable anyway),
  // starts no new one.
  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (active) await active.catch(() => {})
  }

  return { start, stop, tick, step, prepare, sync }
}

let instance = null

// The bot's worker, wired to the real database and Telegram client. Built on
// first use so requiring this file stays free of side effects.
function getWorker () {
  if (!instance) {
    const { db } = require('../database')
    const telegram = require('../utils/telegram')
    const { publishCommit, mongoStore } = require('./index')
    const { mongoRepo } = require('./worker-repo')
    instance = createWorker({
      repo: mongoRepo(db),
      store: mongoStore(db),
      telegram,
      publish: (id) => publishCommit(db, telegram, id)
    })
  }
  return instance
}

module.exports = {
  createWorker,
  getWorker,
  start: () => getWorker().start(),
  stop: () => (instance ? instance.stop() : Promise.resolve())
}
