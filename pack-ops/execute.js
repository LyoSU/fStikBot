// Publish executor for pack-ops: runs a commit (a draft of a pack) against
// Telegram as a resumable state machine. Every step is written down before
// the request and after the answer, so a crash, a timeout or a lost reply
// never leaves us guessing — on the next run an unfinished step is checked
// against getStickerSet before it is repeated.
//
// The executor gets its world injected — `telegram` (callApi), `store`
// (commit persistence) and `lock` (one publish per pack) — so tests run it
// against an in-memory pack with faults on every step, and the bot runs it
// against the real API and MongoDB.

const { hasConflict, sameList, mergeOutside, planContent, mapAfterContent, planMoves, planMetadata, planSettings } = require('./plan')
const { autoNameCandidates, customNameCandidates, NAME_REJECTED } = require('./names')
const { redactBotToken } = require('../utils/telegram-error')

// Commit status:
//   pending      created, never run
//   running      a run holds the pack lock
//   interrupted  stopped by something that may pass (429 beyond the wait,
//                network); run again to continue
//   conflict     the pack changed outside the draft in a way the draft
//                can't be carried over (plan.js mergeOutside); nothing was
//                changed
//   failed       Telegram refused a step outright; steps before it stay
//                applied, the commit can't continue as planned
//   succeeded    the pack matches the draft
//
// Step state: pending → running → succeeded | uncertain | failed.
// `running` found on a later run means the process died mid-request: it is
// handled exactly like `uncertain`.

const LOCK_TTL_MS = 2 * 60 * 1000

const uidsOf = (set) => set.stickers.map((s) => s.file_unique_id)

const inputSticker = (item, format) => ({
  sticker: item.file.fileId,
  format: item.file.format || format,
  emoji_list: item.emojiList,
  ...(item.keywords?.length ? { keywords: item.keywords } : {})
})

// A Telegram answer (an error with a code) is final; anything else — a
// timeout, a reset connection — may or may not have reached Telegram.
const isTelegramAnswer = (err) => Number.isInteger(err?.code) || Number.isInteger(err?.response?.error_code)
const errorCode = (err) => err?.code ?? err?.response?.error_code
// Stored on the commit and shown in Studio: never with the bot token in it.
const errorText = (err) => redactBotToken(err?.description || err?.response?.description || err?.message || String(err))

// A delete of a sticker the set no longer holds (measured: a second delete of
// one sticker is STICKERSET_NOT_MODIFIED).
const isStickerGone = (err) => /STICKER_INVALID|sticker not found|STICKERSET_NOT_MODIFIED/i.test(errorText(err))

// What Telegram answers about a set that is gone, and also about one this bot
// didn't make; a second deleteStickerSet of a set says STICKERPACK_NOT_FOUND.
const isSetInvalid = (err) => /STICKERSET_INVALID|STICKERPACK_NOT_FOUND/i.test(errorText(err))

// The owner never started the bot (Telegram knows no such user for it, or
// says it has no access to them), or blocked it: Telegram makes no pack for
// them and touches none of theirs. Every call names the owner's user_id, so
// it is always the owner, never the one who published. Stable codes, so the
// client can say what to do; not a fault of the worker.
const BOT_NOT_STARTED = 'bot_not_started'
const BOT_BLOCKED = 'bot_blocked'
function ownerProblem (err) {
  const text = errorText(err)
  if (/bot was blocked by the user/i.test(text)) return BOT_BLOCKED
  if (/user not found|have no access to the user|PEER_ID_INVALID/i.test(text)) return BOT_NOT_STARTED
  return null
}

// A title or thumbnail that is already what was asked for.
const isNotModified = (err) => /not modified|NOT_MODIFIED/i.test(errorText(err))

// createNewStickerSet takes at most this many stickers; the rest are added.
const CREATE_BATCH = 50

// Final errors of a create that the client explains in its own words.
const NAME_OCCUPIED = 'name_occupied'
const NAME_INVALID = 'name_invalid'

const THUMBNAIL_EXT = { static: 'webp', animated: 'tgs', video: 'webm' }

class Interrupted extends Error {}
// A sticker a step needs that the pack doesn't have (not even in a reread copy).
class StickerMissing extends Interrupted {}

/**
 * Run (or resume) a commit until it succeeds or can't go on.
 *
 * @param {Object} commit see pack-ops/README.md for the shape
 * @param {Object} deps
 * @param {{callApi: Function}} deps.telegram
 * @param {{save: Function}} deps.store persists the whole commit
 * @param {{acquire: Function, extend: Function, release: Function}} deps.lock
 * @param {{load: Function}} [deps.assets] (assetId) => { data, format }, for a pack thumbnail
 * @param {Function} [deps.formatTitle] (commit, title) => the title as Telegram should get it
 * @param {Function} [deps.botUsername] () => the bot's username, for a new pack's name
 * @param {Function} [deps.nameTaken] (name) => whether our database already has a pack of that name
 * @param {Function} [deps.register] (commit) => the new pack's document id; makes the bot's own records of it
 * @param {Function} [deps.readFresh] (name) => the set as Telegram's servers hold it now, or a 400 for none;
 *   getStickerSet answers from the Bot API's copy, which can be minutes behind a pack edited in a Telegram app
 * @param {Function} [deps.freshUids] (name, expected) => the pack's file_unique_ids as the server has them, or
 *   null when unknown; the draft is planned on these, and they stand in for the Bot API's copy while it lags
 * @param {Function} [deps.onProgress] (commit) after every step
 * @param {number} [deps.lockRenewMs] how often the lock is extended while the run lasts
 * @returns {Promise<Object>} the commit, with its final status
 */
async function runCommit (commit, { telegram, store, lock, assets, formatTitle = (_, title) => title, botUsername, nameTaken, register, readFresh, freshUids, onProgress, lockRenewMs = LOCK_TTL_MS / 4 }) {
  if (commit.status === 'succeeded' || commit.status === 'conflict' || commit.status === 'failed') return commit

  // A new pack's name changes once it is made; the lock stays under the first.
  const lockName = commit.lockName || commit.name
  const token = await lock.acquire(lockName, LOCK_TTL_MS)
  if (!token) return commit // another run holds the pack; it will finish this

  // A single call can wait out a 429 for minutes, longer than the lock lives.
  // Keep extending it meanwhile; if it is lost anyway, the extend before the
  // next step notices and stops the run.
  const renewal = setInterval(() => { lock.extend(lockName, token, LOCK_TTL_MS).catch(() => {}) }, lockRenewMs)
  renewal.unref()

  const call = (method, params) => telegram.callApi(method, params)
  const getSet = () => call('getStickerSet', { name: commit.name })
  // Whether Telegram has no such set, asked of the freshest source there is.
  // Only a 400 says so; a set that is there (made by another bot, or a copy
  // the Bot API still keeps) is not gone.
  const packGone = () => (readFresh ? readFresh(commit.name) : getSet()).then(() => false, (err) => {
    if (isTelegramAnswer(err) && errorCode(err) === 400) return true
    throw err
  })
  // The pack as it is now: the Bot API's copy for file_ids, and its
  // file_unique_ids unless the copy lags behind the server (`commit.stale`,
  // seen when the commit was planned). Then the server's list stands in until
  // the copy shows the same, which this bot's first write brings about.
  // A sticker a delete found already gone is gone, whatever the copy shows.
  const readPack = async () => {
    const set = await getSet()
    const gone = new Set(commit.steps.filter((step) => step.alreadyGone).map((step) => step.fileUniqueId))
    const copy = uidsOf(set).filter((id) => !gone.has(id))
    if (!commit.stale) return { set, uids: copy }
    const fresh = freshUids ? await freshUids(commit.name, commit.contentBase || commit.base).catch(() => null) : null
    if (fresh && sameList(fresh, uidsOf(set))) commit.stale = false
    return { set, uids: fresh || copy }
  }
  const save = async () => {
    commit.updatedAt = new Date()
    await store.save(commit)
    if (onProgress) onProgress(commit)
  }

  try {
    commit.status = 'running'
    commit.error = null
    await save()

    if (commit.remove) {
      await removePack(commit, { call, packGone, save })
      return commit
    }

    if (commit.create && commit.create.state !== 'done') {
      const made = await createPack(commit, { call, save, formatTitle, botUsername, nameTaken, register })
      if (!made) return commit
    }

    if (!commit.phase) {
      const set = await getSet()
      // The Bot API's copy can be minutes behind an edit made in a Telegram
      // app, and the draft (opened through the API) may stand on that copy too.
      // The server's own list is the pack the steps will meet. A fresh read
      // that fails is no reason to stop: the copy is all there is then.
      const fresh = freshUids && !commit.create ? await freshUids(commit.name, commit.base).catch(() => null) : null
      const now = fresh || uidsOf(set)
      commit.stale = !sameList(now, uidsOf(set))
      if (hasConflict(commit.base, now)) {
        const merged = mergeOutside(commit.base, now, commit.draft, new Map(Object.entries(commit.known || {})))
        if (merged.conflicts) {
          commit.status = 'conflict'
          commit.error = CHANGED_OUTSIDE
          // What the client rebases on: the Bot API it reads may still show the
          // pack as it was.
          commit.fresh = now
          commit.conflicts = merged.conflicts
          return commit
        }
        commit.rebased = merged.draft
        commit.outside = { deleted: commit.base.filter((id) => !now.includes(id)), added: now.filter((id) => !commit.base.includes(id)) }
      }
      const content = planContent(draftOf(commit), now)
      commit.format = commit.format || set.stickers[0]?.format || 'static'
      commit.contentBase = now
      commit.steps = [
        ...content.deletes.map((fileUniqueId) => ({ kind: 'delete', fileUniqueId })),
        ...content.replaces.map((item) => ({ kind: 'replace', fileUniqueId: item.fileUniqueId, assetId: item.assetId })),
        ...content.adds.map((item) => ({ kind: 'add', assetId: item.assetId }))
      ].map((step) => ({ ...step, phase: 'content', state: 'pending' }))
      commit.phase = 'content'
      await save()
    }

    if (commit.phase === 'content') {
      await runSteps(commit, 'content', { call, getSet, readPack, save, lock, lockName, token })
      commit.phase = 'arrange'
      await save()
    }

    if (commit.phase === 'arrange') {
      const { uids: now } = await readPack()
      if (!commit.mapping) {
        const draft = publishedDraft(commit)
        const content = planContent(draft, commit.contentBase)
        const mapped = mapAfterContent(draft, commit.contentBase, content, now)
        if (mapped.error) {
          commit.status = 'failed'
          commit.error = `${CHANGED}: ${mapped.error}`
          return commit
        }
        commit.mapping = Object.fromEntries(mapped.ok)
        const target = draft.map((item) => commit.mapping[item.assetId])
        const known = new Map(Object.entries(commit.known || {}))
        commit.steps.push(
          ...planMoves(now, target).map((move) => ({ kind: 'move', ...move })),
          ...planMetadata(draft, known).flatMap((update) => [
            update.emojiList && { kind: 'emoji', fileUniqueId: update.fileUniqueId, emojiList: update.emojiList },
            update.keywords && { kind: 'keywords', fileUniqueId: update.fileUniqueId, keywords: update.keywords }
          ].filter(Boolean)).map((step) => ({ ...step }))
        )
        for (const step of commit.steps) if (!step.phase) Object.assign(step, { phase: 'arrange', state: 'pending' })
        await save()
      }
      await runSteps(commit, 'arrange', { call, getSet, readPack, save, lock, lockName, token })
      commit.phase = 'settings'
      await save()
    }

    // Title and thumbnail go last: they need no part of the pack's order, and
    // a thumbnail picked from a sticker needs the final stickers.
    if (commit.phase === 'settings') {
      if (commit.settings && !commit.steps.some((step) => step.phase === 'settings')) {
        const steps = planSettings(commit.settings)
        for (const step of steps) {
          if (step.kind === 'title') step.title = await formatTitle(commit, step.title)
          Object.assign(step, { phase: 'settings', state: 'pending' })
        }
        commit.steps.push(...steps)
        await save()
      }
      await runSteps(commit, 'settings', { call, getSet, readPack, save, lock, lockName, token, assets })
      commit.phase = 'verify'
      await save()
    }

    const { uids: final } = await readPack()
    const target = publishedDraft(commit).map((item) => commit.mapping[item.assetId])
    if (final.length !== target.length || final.some((id, i) => id !== target[i])) {
      commit.status = 'failed'
      commit.error = 'the pack does not match the draft after the publish'
      return commit
    }
    commit.phase = 'done'
    commit.status = 'succeeded'
    return commit
  } catch (err) {
    commit.error = errorText(err)
    if (err instanceof Interrupted || !isTelegramAnswer(err) || errorCode(err) === 429) {
      commit.status = 'interrupted'
    } else {
      commit.status = 'failed'
      commit.error = ownerProblem(err) || commit.error
      // The pack was deleted in Telegram (@Stickers, a Telegram app). The
      // worker then marks it deleted, as after the bot's own delete. A remove
      // has asked already.
      if (!commit.remove && isSetInvalid(err) && await packGone().catch(() => false)) {
        commit.packGone = true
        commit.error = PACK_GONE
      }
    }
    return commit
  } finally {
    clearInterval(renewal)
    await save().catch(() => {})
    await lock.release(lockName, token).catch(() => {})
  }
}

// Steps of one phase, in order. A step left `running`/`uncertain` by an
// earlier run is reconciled against the pack before anything else happens.
async function runSteps (commit, phase, { call, getSet, readPack, save, lock, lockName, token, assets }) {
  // The pack as it stands, kept current: reread after every add/replace (to
  // check what Telegram did) and patched locally after a delete. `set` is the
  // Bot API's copy, for file_ids; `now` the file_unique_ids in order.
  let { set, uids: now } = await readPack()
  const fileIdOf = async (uid) => {
    let sticker = set.stickers.find((s) => s.file_unique_id === uid)
    if (!sticker) {
      // A sticker added outside shows in the copy once it has caught up.
      set = await getSet()
      sticker = set.stickers.find((s) => s.file_unique_id === uid)
    }
    if (!sticker) throw new StickerMissing(`sticker ${uid} is not in the pack`)
    return sticker.file_id
  }
  const itemOf = (assetId) => draftOf(commit).find((item) => item.assetId === assetId)
  const customEmojiIdOf = (uid) => {
    const id = set.stickers.find((s) => s.file_unique_id === uid)?.custom_emoji_id
    if (!id) throw Object.assign(new Error(`sticker ${uid} has no custom emoji id`), { code: 400 })
    return id
  }
  const refuse = async (step, message) => {
    step.state = 'failed'
    step.error = message
    await save()
    throw Object.assign(new Error(message), { code: 400 })
  }
  // Telegram keeps one sticker per file: this item's file is a sticker the
  // pack already has, so that one sticker stands for both. The item is left
  // out of the pack (arrange and the verify go without it) and the job says
  // which it was; the rest of the draft goes on.
  const merged = async (step) => {
    step.merged = true
    step.state = 'succeeded'
    await save()
  }

  for (const step of commit.steps) {
    if (step.phase !== phase || step.state === 'succeeded') continue
    if (step.state === 'failed') throw Object.assign(new Error(step.error), { code: 400 })

    // Arrange steps are idempotent (a position or emoji set twice is the
    // same), so an unanswered one is simply repeated. Content steps leave a
    // trace in the pack, read before anything is repeated.
    if ((step.state === 'running' || step.state === 'uncertain') && step.phase === 'content') {
      ;({ set, uids: now } = await readPack())
      const effect = effectOf(commit, step, now)
      if (effect === 'applied') {
        if (step.kind === 'add') step.newFileUniqueId = now[now.length - 1]
        step.state = 'succeeded'
        await save()
        continue
      }
      if (effect === 'duplicate') {
        await merged(step)
        continue
      }
      if (effect === 'unexpected') await refuse(step, CHANGED)
    }

    // A title or thumbnail the pack already has is done, whether a lost answer
    // or an earlier edit got it there.
    if (step.phase === 'settings' && settingDone(step, set)) {
      step.state = 'succeeded'
      await save()
      continue
    }

    if (!await lock.extend(lockName, token, LOCK_TTL_MS)) throw new Interrupted('lost the pack lock')

    step.state = 'running'
    step.attempts = (step.attempts || 0) + 1
    await save()

    const prev = now
    try {
      await applyStep(commit, step, { call, fileIdOf, itemOf, customEmojiIdOf, assets })
      step.error = null
    } catch (err) {
      step.error = errorText(err)
      if (step.kind === 'delete' && (err instanceof StickerMissing || (isTelegramAnswer(err) && isStickerGone(err)))) {
        // Not in the set any more (deleted elsewhere since the plan, or by an
        // attempt whose answer got lost): what the step was for. A deleted
        // sticker has nothing else planned on it, so the publish goes on. The
        // copy may lag behind whatever deleted it.
        step.alreadyGone = true
        commit.stale = true
      } else if (step.phase === 'settings' && isTelegramAnswer(err) && isNotModified(err)) {
        // Already as asked: done.
      } else if (!isTelegramAnswer(err)) {
        // No answer: maybe applied, maybe not. Leave it for the reconcile.
        step.state = 'uncertain'
        await save()
        throw err
      } else if (errorCode(err) === 429) {
        step.state = 'pending'
        await save()
        throw err
      } else {
        await refuse(step, step.error)
      }
    }

    // "ok" from Telegram is not proof of a new sticker: a file already in the
    // pack is merged instead (plan 7.1). Check what actually happened.
    if (step.kind === 'add' || step.kind === 'replace') {
      ;({ set, uids: now } = await readPack())
      const effect = effectOf(commit, step, now, prev)
      if (effect === 'duplicate') {
        await merged(step)
        continue
      }
      if (effect !== 'applied') await refuse(step, CHANGED)
      step.newFileUniqueId = step.kind === 'add' ? now[now.length - 1] : now[prev.indexOf(step.fileUniqueId)]
    } else if (step.kind === 'delete') {
      now = now.filter((id) => id !== step.fileUniqueId)
    }

    step.state = 'succeeded'
    await save()
  }
}

// Makes the pack of a `create` commit, the way the /new wizard does: the first
// names Telegram accepts wins, and the first stickers go into the same
// createNewStickerSet call (it takes none empty). Resumable: the name under
// attempt is written down before the call, so a run that finds it `creating`
// asks Telegram whether the set is there before creating anything. A name is
// only tried after getStickerSet says nobody has it, which is what makes an
// existing set under the attempted name ours.
//
// On success the draft's first stickers become kept ones (they are in the
// pack now), `base` is the pack as made, and the rest goes through the usual
// content phase. Returns false when the commit has been settled as failed.
async function createPack (commit, { call, save, formatTitle, botUsername, nameTaken, register }) {
  const create = commit.create
  const read = (name) => call('getStickerSet', { name }).catch((err) => {
    if (isTelegramAnswer(err) && /STICKERSET_INVALID|not found/i.test(errorText(err))) return null
    throw err
  })

  if (create.state !== 'created') {
    if (!create.names) {
      const suffix = `_by_${await botUsername()}`
      // `nameAuto`: Studio made the link from the title itself (to show it); a
      // taken one gets a random tail, as a link made here would.
      create.names = create.name && !create.nameAuto
        ? customNameCandidates(create.name, suffix)
        : autoNameCandidates(create.name || create.title, suffix)
      if (!create.names) return refuseCreate(commit, NAME_INVALID, save)
      // The first title carries the bot's suffix even on a pack that starts
      // with Boost (a copy), like the wizard's; a later rename can drop it.
      create.formattedTitle = await formatTitle({ ...commit, boost: false }, create.title)
      // Read now, before the first items become kept ones and lose their source.
      create.copyBoost = copyEarnsBoost(commit)
      create.index = 0
      await save()
    }

    const seed = commit.draft.slice(0, CREATE_BATCH)
    commit.known = commit.known || {}
    let set = null
    let reason = NAME_OCCUPIED

    for (; create.index < create.names.length && !set; create.index++) {
      const name = create.names[create.index]
      const there = await read(name)

      // Ours if the attempt was written down and the set carries our title.
      if (there && create.state === 'creating' && create.attempt === name && there.title === create.formattedTitle) {
        set = there
        break
      }
      if (there || (nameTaken && await nameTaken(name))) continue

      create.state = 'creating'
      create.attempt = name
      commit.name = name
      await save()

      try {
        await call('createNewStickerSet', {
          user_id: commit.ownerTelegramId,
          name,
          title: create.formattedTitle,
          stickers: seed.map((item) => inputSticker(item, commit.format)),
          sticker_type: commit.packType || 'regular',
          needs_repainting: !!create.needsRepainting
        })
      } catch (err) {
        // No answer: the set may exist. Stay `creating`; the next run asks.
        if (!isTelegramAnswer(err) || !NAME_REJECTED.test(errorText(err))) throw err
        reason = /invalid/i.test(errorText(err)) && !/occupied/i.test(errorText(err)) ? NAME_INVALID : NAME_OCCUPIED
        create.state = 'pending'
        continue
      }
      set = await read(name)
      if (!set) throw Object.assign(new Error('the new pack is not visible yet'), { code: 'ENOTFOUND' })
    }

    if (!set) return refuseCreate(commit, reason, save)

    const uids = uidsOf(set)
    seed.forEach((item, i) => {
      if (!uids[i]) return
      item.fileUniqueId = uids[i]
      delete item.file
      commit.known[uids[i]] = { emojiList: item.emojiList, ...(item.keywords ? { keywords: item.keywords } : {}) }
    })
    commit.base = uids
    commit.format = set.stickers[0]?.format
    create.seeded = seed.length
    create.state = 'created'
    await save()

    // Merged files shrink the set; the plan would be built on the wrong pack.
    if (uids.length !== seed.length) {
      commit.status = 'failed'
      commit.error = `the pack was created, but ${DUPLICATE}`
      return false
    }
  }

  if (register && !create.registered) {
    commit.stickerSet = await register(commit)
    create.registered = true
  }
  create.state = 'done'
  await save()
  return true
}

// A new pack starts with Boost only as a copy, on the terms the API checks too:
// every item a sticker of the copied set (a copy of the same type, free), or
// the copy paid for (into the other type, whose converted files can't show
// where they came from). Anything else asking for it doesn't get it.
function copyEarnsBoost (commit) {
  const from = commit.create?.copyOf
  if (!commit.boost || !from) return false
  if (commit.charge?.credits > 0) return true
  return commit.draft.every((item) => item.file?.copy && String(item.file.copy.set).toLowerCase() === from.toLowerCase())
}

function refuseCreate (commit, error, save) {
  commit.status = 'failed'
  commit.error = error
  commit.create.state = 'pending'
  return save().then(() => false)
}

const DUPLICATE = 'duplicate: Telegram keeps one sticker per file in a pack, and this file is already there'
const CHANGED = 'the pack changed during the publish'
const CHANGED_OUTSIDE = 'the pack changed outside the draft'
// The pack is no longer in Telegram. Telegram's own word stays in it: the
// client reads STICKERSET_INVALID as a pack that is gone.
const PACK_GONE = 'pack_gone: the pack is no longer in Telegram (STICKERSET_INVALID)'

// The draft the steps carry out: as sent, or carried over to a pack that
// changed outside it (`commit.rebased`, plan.js mergeOutside).
const draftOf = (commit) => commit.rebased || commit.draft

// That draft without the items Telegram merged into a sticker already in the
// pack: what the pack is to hold, in order.
function publishedDraft (commit) {
  const merged = new Set(commit.steps.filter((step) => step.merged).map((step) => step.assetId))
  const draft = draftOf(commit)
  return merged.size ? draft.filter((item) => !merged.has(item.assetId)) : draft
}

// Whether the pack already shows what a settings step would set. A thumbnail
// can only be compared when it is to be dropped; setting one again is harmless.
function settingDone (step, set) {
  if (step.kind === 'title') return set.title === step.title
  if (step.kind === 'thumbnail' && !step.assetId && !step.fromSticker) return !set.thumbnail
  return false
}

async function setThumbnail (commit, step, { call, customEmojiIdOf, assets }) {
  if (commit.packType === 'custom_emoji') {
    if (step.assetId) throw Object.assign(new Error('a custom emoji pack takes its thumbnail from a sticker'), { code: 400 })
    // An empty id drops the thumbnail.
    return call('setCustomEmojiStickerSetThumbnail', {
      name: commit.name,
      custom_emoji_id: step.fromSticker ? customEmojiIdOf(step.fromSticker) : ''
    })
  }

  if (step.fromSticker) throw Object.assign(new Error('a thumbnail of a regular pack is an uploaded file'), { code: 400 })

  const params = { name: commit.name, user_id: commit.ownerTelegramId, format: 'static' }
  if (step.assetId) {
    const asset = await assets?.load(step.assetId)
    if (!asset) throw Object.assign(new Error('asset_missing'), { code: 400 })
    params.format = asset.format
    params.thumbnail = { source: asset.data, filename: `thumbnail.${THUMBNAIL_EXT[asset.format]}` }
  }
  return call('setStickerSetThumbnail', params)
}

async function applyStep (commit, step, { call, fileIdOf, itemOf, customEmojiIdOf, assets }) {
  const userId = commit.ownerTelegramId
  switch (step.kind) {
    case 'delete':
      return call('deleteStickerFromSet', { sticker: await fileIdOf(step.fileUniqueId) })
    case 'replace':
      return call('replaceStickerInSet', {
        user_id: userId,
        name: commit.name,
        old_sticker: await fileIdOf(step.fileUniqueId),
        sticker: inputSticker(itemOf(step.assetId), commit.format)
      })
    case 'add':
      return call('addStickerToSet', { user_id: userId, name: commit.name, sticker: inputSticker(itemOf(step.assetId), commit.format) })
    case 'move':
      return call('setStickerPositionInSet', { sticker: await fileIdOf(step.fileUniqueId), position: step.position })
    case 'emoji':
      return call('setStickerEmojiList', { sticker: await fileIdOf(step.fileUniqueId), emoji_list: step.emojiList })
    case 'keywords':
      return call('setStickerKeywords', { sticker: await fileIdOf(step.fileUniqueId), keywords: step.keywords })
    case 'title':
      return call('setStickerSetTitle', { name: commit.name, title: step.title })
    case 'thumbnail':
      return setThumbnail(commit, step, { call, customEmojiIdOf, assets })
    default:
      throw new Error(`unknown step ${step.kind}`)
  }
}

// How many stickers the pack holds right before `step`. Steps run one at a
// time, so every earlier content step is settled. A merged add left the pack
// as it was; a merged replace took its old sticker out.
function countBefore (commit, step) {
  const earlier = commit.steps.slice(0, commit.steps.indexOf(step)).filter((s) => s.phase === 'content')
  return commit.contentBase.length -
    earlier.filter((s) => s.kind === 'delete' || (s.kind === 'replace' && s.merged)).length +
    earlier.filter((s) => s.kind === 'add' && !s.merged).length
}

/**
 * What a content step did to the pack (`uids`, read after it):
 *   applied     it happened
 *   none        it didn't (only after a lost answer: safe to send again)
 *   duplicate   Telegram merged it with a sticker of the same file already in
 *               the pack: an add does nothing, a replace moves that sticker
 *               into place and the pack shrinks by one
 *   unexpected  the pack doesn't fit either — someone changed it meanwhile
 * `prev`, the pack right before the call, is known when Telegram answered;
 * after a lost answer only the counts are.
 */
function effectOf (commit, step, uids, prev) {
  const before = countBefore(commit, step)
  switch (step.kind) {
    case 'delete':
      return uids.includes(step.fileUniqueId) ? 'none' : 'applied'
    case 'add':
      if (uids.length === before + 1) return !prev || !prev.includes(uids[uids.length - 1]) ? 'applied' : 'unexpected'
      // After an answered add an unchanged count is a merge; after a lost
      // answer it may also be an add that never arrived — send it again and
      // let the answered attempt tell.
      if (uids.length === before) return prev ? 'duplicate' : 'none'
      return 'unexpected'
    case 'replace':
      if (uids.includes(step.fileUniqueId)) {
        if (uids.length !== before) return 'unexpected'
        // Answered, and the pack is as it was: the new file is the one this
        // sticker was made from, and Telegram handed back the same sticker.
        if (prev) return uids.every((id, i) => id === prev[i]) ? 'applied' : 'unexpected'
        return 'none'
      }
      if (uids.length === before - 1) return 'duplicate'
      if (uids.length !== before) return 'unexpected'
      if (prev && prev.includes(uids[prev.indexOf(step.fileUniqueId)])) return 'unexpected'
      return 'applied'
    default:
      return 'unexpected'
  }
}

/**
 * A new commit for `draft` over the pack as it was opened (`base`).
 *
 * @param {Object} params
 * @param {string} params.name pack short name
 * @param {number} params.ownerTelegramId user_id the pack belongs to
 * @param {string[]} params.base file_unique_ids when the draft was opened
 * @param {Object[]} params.draft DraftItem[] (see plan.js)
 * @param {Object} [params.known] fileUniqueId → { emojiList, keywords } from our DB
 * @param {Object} [params.settings] { title?, thumbnail? }, see plan.js planSettings
 * @param {string} [params.packType] 'regular' | 'custom_emoji'
 * @param {Object} [params.create] makes the pack first: { title, name?, needsRepainting? };
 *   `name` is the provisional one (and the lock's), `base` is []
 */
// Deletes the whole set (the bot's "Delete pack"), as one step. Telegram calls
// a set it doesn't know STICKERSET_INVALID (STICKERPACK_NOT_FOUND once this bot
// has deleted it), and says the same to a bot that didn't make the set, so that
// answer only counts as done once Telegram can't find the set either. A step
// left `running` by a dead process is just sent again.
async function removePack (commit, { call, packGone, save }) {
  let step = commit.steps.find((entry) => entry.kind === 'remove')
  if (!step) {
    step = { kind: 'remove', phase: 'remove', state: 'pending' }
    commit.steps.push(step)
    commit.phase = 'remove'
  }

  if (step.state !== 'succeeded') {
    step.state = 'running'
    await save()
    try {
      await call('deleteStickerSet', { name: commit.name })
    } catch (err) {
      if (!isTelegramAnswer(err) || !isSetInvalid(err)) throw err
      if (!await packGone()) {
        step.state = 'failed'
        step.error = errorText(err)
        throw err
      }
    }
    step.state = 'succeeded'
  }

  commit.phase = 'done'
  commit.status = 'succeeded'
}

function newCommit ({ name, ownerTelegramId, base, draft, known = {}, settings, packType, create }) {
  return {
    name,
    ownerTelegramId,
    base,
    draft,
    known,
    ...(settings ? { settings } : {}),
    ...(packType ? { packType } : {}),
    ...(create ? { create, lockName: name } : {}),
    status: 'pending',
    phase: null,
    steps: [],
    mapping: null,
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

module.exports = { runCommit, newCommit, ownerProblem, copyEarnsBoost, LOCK_TTL_MS }
