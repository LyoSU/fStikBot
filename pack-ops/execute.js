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

const { hasConflict, planContent, mapAfterContent, planMoves, planMetadata, planSettings } = require('./plan')
const { autoNameCandidates, customNameCandidates, NAME_REJECTED } = require('./names')

// Commit status:
//   pending      created, never run
//   running      a run holds the pack lock
//   interrupted  stopped by something that may pass (429 beyond the wait,
//                network); run again to continue
//   conflict     the pack changed outside the draft before anything ran;
//                nothing was changed
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
const errorText = (err) => err?.description || err?.response?.description || err?.message || String(err)

// A sticker that is already gone answers this way; for a delete that means done.
const isGone = (err) => /STICKER_INVALID|sticker not found|STICKERSET_INVALID/i.test(errorText(err))

// A title or thumbnail that is already what was asked for.
const isNotModified = (err) => /not modified|NOT_MODIFIED/i.test(errorText(err))

// createNewStickerSet takes at most this many stickers; the rest are added.
const CREATE_BATCH = 50

// Final errors of a create that the client explains in its own words.
const NAME_OCCUPIED = 'name_occupied'
const NAME_INVALID = 'name_invalid'

const THUMBNAIL_EXT = { static: 'webp', animated: 'tgs', video: 'webm' }

class Interrupted extends Error {}

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
 * @param {Function} [deps.onProgress] (commit) after every step
 * @param {number} [deps.lockRenewMs] how often the lock is extended while the run lasts
 * @returns {Promise<Object>} the commit, with its final status
 */
async function runCommit (commit, { telegram, store, lock, assets, formatTitle = (_, title) => title, botUsername, nameTaken, register, onProgress, lockRenewMs = LOCK_TTL_MS / 4 }) {
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
      await removePack(commit, { call, getSet, save })
      return commit
    }

    if (commit.create && commit.create.state !== 'done') {
      const made = await createPack(commit, { call, save, formatTitle, botUsername, nameTaken, register })
      if (!made) return commit
    }

    if (!commit.phase) {
      const set = await getSet()
      if (hasConflict(commit.base, uidsOf(set))) {
        commit.status = 'conflict'
        commit.error = 'the pack changed outside the draft'
        return commit
      }
      const content = planContent(commit.draft, uidsOf(set))
      commit.format = commit.format || set.stickers[0]?.format || 'static'
      commit.contentBase = uidsOf(set)
      commit.steps = [
        ...content.deletes.map((fileUniqueId) => ({ kind: 'delete', fileUniqueId })),
        ...content.replaces.map((item) => ({ kind: 'replace', fileUniqueId: item.fileUniqueId, assetId: item.assetId })),
        ...content.adds.map((item) => ({ kind: 'add', assetId: item.assetId }))
      ].map((step) => ({ ...step, phase: 'content', state: 'pending' }))
      commit.phase = 'content'
      await save()
    }

    if (commit.phase === 'content') {
      await runSteps(commit, 'content', { call, getSet, save, lock, lockName, token })
      commit.phase = 'arrange'
      await save()
    }

    if (commit.phase === 'arrange') {
      const set = await getSet()
      if (!commit.mapping) {
        const content = planContent(commit.draft, commit.contentBase)
        const mapped = mapAfterContent(commit.draft, commit.contentBase, content, uidsOf(set))
        if (mapped.error) {
          commit.status = 'failed'
          commit.error = `the pack changed during the publish: ${mapped.error}`
          return commit
        }
        commit.mapping = Object.fromEntries(mapped.ok)
        const target = commit.draft.map((item) => commit.mapping[item.assetId])
        const known = new Map(Object.entries(commit.known || {}))
        commit.steps.push(
          ...planMoves(uidsOf(set), target).map((move) => ({ kind: 'move', ...move })),
          ...planMetadata(commit.draft, known).flatMap((update) => [
            update.emojiList && { kind: 'emoji', fileUniqueId: update.fileUniqueId, emojiList: update.emojiList },
            update.keywords && { kind: 'keywords', fileUniqueId: update.fileUniqueId, keywords: update.keywords }
          ].filter(Boolean)).map((step) => ({ ...step }))
        )
        for (const step of commit.steps) if (!step.phase) Object.assign(step, { phase: 'arrange', state: 'pending' })
        await save()
      }
      await runSteps(commit, 'arrange', { call, getSet, save, lock, lockName, token })
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
      await runSteps(commit, 'settings', { call, getSet, save, lock, lockName, token, assets })
      commit.phase = 'verify'
      await save()
    }

    const final = uidsOf(await getSet())
    const target = commit.draft.map((item) => commit.mapping[item.assetId])
    if (final.length !== target.length || final.some((id, i) => id !== target[i])) {
      commit.status = 'failed'
      commit.error = 'the pack does not match the draft after the publish'
      return commit
    }
    commit.phase = 'done'
    commit.status = 'succeeded'
    return commit
  } catch (err) {
    if (err instanceof Interrupted || !isTelegramAnswer(err) || errorCode(err) === 429) {
      commit.status = 'interrupted'
    } else {
      commit.status = 'failed'
    }
    commit.error = errorText(err)
    return commit
  } finally {
    clearInterval(renewal)
    await save().catch(() => {})
    await lock.release(lockName, token).catch(() => {})
  }
}

// Steps of one phase, in order. A step left `running`/`uncertain` by an
// earlier run is reconciled against the pack before anything else happens.
async function runSteps (commit, phase, { call, getSet, save, lock, lockName, token, assets }) {
  // The pack as it stands, kept current: refetched after every add/replace
  // (to check what Telegram did) and patched locally after a delete.
  let set = await getSet()
  const fileIdOf = (uid) => {
    const sticker = set.stickers.find((s) => s.file_unique_id === uid)
    if (!sticker) throw new Interrupted(`sticker ${uid} is not in the pack`)
    return sticker.file_id
  }
  const itemOf = (assetId) => commit.draft.find((item) => item.assetId === assetId)
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

  for (const step of commit.steps) {
    if (step.phase !== phase || step.state === 'succeeded') continue
    if (step.state === 'failed') throw Object.assign(new Error(step.error), { code: 400 })

    // Arrange steps are idempotent (a position or emoji set twice is the
    // same), so an unanswered one is simply repeated. Content steps leave a
    // trace in the pack, read before anything is repeated.
    if ((step.state === 'running' || step.state === 'uncertain') && step.phase === 'content') {
      set = await getSet()
      const effect = effectOf(commit, step, uidsOf(set))
      if (effect === 'applied') {
        step.state = 'succeeded'
        await save()
        continue
      }
      if (effect === 'duplicate') await refuse(step, DUPLICATE)
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

    const prev = uidsOf(set)
    try {
      await applyStep(commit, step, { call, fileIdOf, itemOf, customEmojiIdOf, assets })
      step.error = null
    } catch (err) {
      step.error = errorText(err)
      if (step.kind === 'delete' && isTelegramAnswer(err) && isGone(err)) {
        // Already gone: done.
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
      set = await getSet()
      const uids = uidsOf(set)
      const effect = effectOf(commit, step, uids, prev)
      if (effect === 'duplicate') await refuse(step, DUPLICATE)
      if (effect !== 'applied') await refuse(step, CHANGED)
      step.newFileUniqueId = step.kind === 'add' ? uids[uids.length - 1] : uids[prev.indexOf(step.fileUniqueId)]
    } else if (step.kind === 'delete') {
      set = { ...set, stickers: set.stickers.filter((s) => s.file_unique_id !== step.fileUniqueId) }
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
      create.formattedTitle = await formatTitle(commit, create.title)
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

function refuseCreate (commit, error, save) {
  commit.status = 'failed'
  commit.error = error
  commit.create.state = 'pending'
  return save().then(() => false)
}

const DUPLICATE = 'duplicate: Telegram keeps one sticker per file in a pack, and this file is already there'
const CHANGED = 'the pack changed during the publish'

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

function applyStep (commit, step, { call, fileIdOf, itemOf, customEmojiIdOf, assets }) {
  const userId = commit.ownerTelegramId
  switch (step.kind) {
    case 'delete':
      return call('deleteStickerFromSet', { sticker: fileIdOf(step.fileUniqueId) })
    case 'replace':
      return call('replaceStickerInSet', {
        user_id: userId,
        name: commit.name,
        old_sticker: fileIdOf(step.fileUniqueId),
        sticker: inputSticker(itemOf(step.assetId), commit.format)
      })
    case 'add':
      return call('addStickerToSet', { user_id: userId, name: commit.name, sticker: inputSticker(itemOf(step.assetId), commit.format) })
    case 'move':
      return call('setStickerPositionInSet', { sticker: fileIdOf(step.fileUniqueId), position: step.position })
    case 'emoji':
      return call('setStickerEmojiList', { sticker: fileIdOf(step.fileUniqueId), emoji_list: step.emojiList })
    case 'keywords':
      return call('setStickerKeywords', { sticker: fileIdOf(step.fileUniqueId), keywords: step.keywords })
    case 'title':
      return call('setStickerSetTitle', { name: commit.name, title: step.title })
    case 'thumbnail':
      return setThumbnail(commit, step, { call, customEmojiIdOf, assets })
    default:
      throw new Error(`unknown step ${step.kind}`)
  }
}

// How many stickers the pack holds right before `step`. Steps run one at a
// time, so every earlier content step is settled.
function countBefore (commit, step) {
  const earlier = commit.steps.slice(0, commit.steps.indexOf(step)).filter((s) => s.phase === 'content')
  return commit.contentBase.length -
    earlier.filter((s) => s.kind === 'delete').length +
    earlier.filter((s) => s.kind === 'add').length
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
      if (uids.includes(step.fileUniqueId)) return uids.length === before ? 'none' : 'unexpected'
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
// a set it doesn't know STICKERSET_INVALID, and says the same to a bot that
// didn't make the set, so that answer only counts as done once getStickerSet
// can't find the set either. A step left `running` by a dead process is just
// sent again: the second delete of a set gets that same answer.
async function removePack (commit, { call, getSet, save }) {
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
      if (!isTelegramAnswer(err) || !/STICKERSET_INVALID/i.test(errorText(err))) throw err
      const stillThere = await getSet().then(() => true, (getErr) => {
        if (isTelegramAnswer(getErr) && errorCode(getErr) === 400) return false
        throw getErr
      })
      if (stillThere) {
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

module.exports = { runCommit, newCommit, LOCK_TTL_MS }
