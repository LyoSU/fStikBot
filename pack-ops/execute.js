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

const { hasConflict, planContent, mapAfterContent, planMoves, planMetadata } = require('./plan')

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

class Interrupted extends Error {}

/**
 * Run (or resume) a commit until it succeeds or can't go on.
 *
 * @param {Object} commit see pack-ops/README.md for the shape
 * @param {Object} deps
 * @param {{callApi: Function}} deps.telegram
 * @param {{save: Function}} deps.store persists the whole commit
 * @param {{acquire: Function, extend: Function, release: Function}} deps.lock
 * @param {Function} [deps.onProgress] (commit) after every step
 * @returns {Promise<Object>} the commit, with its final status
 */
async function runCommit (commit, { telegram, store, lock, onProgress }) {
  if (commit.status === 'succeeded' || commit.status === 'conflict' || commit.status === 'failed') return commit

  const token = await lock.acquire(commit.name, LOCK_TTL_MS)
  if (!token) return commit // another run holds the pack; it will finish this

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
      await runSteps(commit, 'content', { call, getSet, save, lock, token })
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
      await runSteps(commit, 'arrange', { call, getSet, save, lock, token })
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
    await save().catch(() => {})
    await lock.release(commit.name, token).catch(() => {})
  }
}

// Steps of one phase, in order. A step left `running`/`uncertain` by an
// earlier run is reconciled against the pack before anything else happens.
async function runSteps (commit, phase, { call, getSet, save, lock, token }) {
  // The pack as it stands, kept current: refetched after every add/replace
  // (to check what Telegram did) and patched locally after a delete.
  let set = await getSet()
  const fileIdOf = (uid) => {
    const sticker = set.stickers.find((s) => s.file_unique_id === uid)
    if (!sticker) throw new Interrupted(`sticker ${uid} is not in the pack`)
    return sticker.file_id
  }
  const itemOf = (assetId) => commit.draft.find((item) => item.assetId === assetId)
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

    if (!await lock.extend(commit.name, token, LOCK_TTL_MS)) throw new Interrupted('lost the pack lock')

    step.state = 'running'
    step.attempts = (step.attempts || 0) + 1
    await save()

    const prev = uidsOf(set)
    try {
      await applyStep(commit, step, { call, fileIdOf, itemOf })
      step.error = null
    } catch (err) {
      step.error = errorText(err)
      if (step.kind === 'delete' && isTelegramAnswer(err) && isGone(err)) {
        // Already gone: done.
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

const DUPLICATE = 'duplicate: Telegram keeps one sticker per file in a pack, and this file is already there'
const CHANGED = 'the pack changed during the publish'

function applyStep (commit, step, { call, fileIdOf, itemOf }) {
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
 */
function newCommit ({ name, ownerTelegramId, base, draft, known = {} }) {
  return {
    name,
    ownerTelegramId,
    base,
    draft,
    known,
    status: 'pending',
    phase: null,
    steps: [],
    mapping: null,
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

module.exports = { runCommit, newCommit, LOCK_TTL_MS }
