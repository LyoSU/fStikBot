// Publish planning for pack-ops: turn a draft of a pack into the fewest Bot
// API calls that make the pack in Telegram match it. Pure functions — no
// network, no database — so the executor can replay a plan after a crash and
// the tests can throw thousands of random packs at it.
//
// Telegram is the source of truth for which stickers a pack holds and in
// what order; our database holds what Telegram won't return (the full emoji
// list, keywords). Stickers are identified by file_unique_id as getStickerSet
// reports it.
//
// A publish runs in two phases, because a sticker added or replaced only
// gets its file_unique_id once Telegram has it:
//   1. content: delete, replace (keeps position), add (appends at the end);
//   2. after getStickerSet: map new stickers by position, then reorder and
//      set metadata.

/**
 * @typedef {Object} DraftItem
 * @property {string} assetId stable id of the item, independent of Telegram
 * @property {string} [fileUniqueId] the sticker in the pack this item keeps
 *   or replaces; absent for a new sticker
 * @property {Object} [file] new content to upload (replace or add); absent
 *   when the sticker is kept as it is
 * @property {string[]} emojiList 1–20 emoji
 * @property {string[]} [keywords] undefined = never set by us, left alone
 */

/**
 * Has the pack changed in Telegram since the draft was opened? MVP rule
 * (plan 2.4): any difference stops the publish — a diff against remote
 * alone would delete stickers someone else added meanwhile.
 *
 * @param {string[]} base file_unique_ids when the draft was opened
 * @param {string[]} remote file_unique_ids now
 * @returns {boolean}
 */
function hasConflict (base, remote) {
  if (base.length !== remote.length) return true
  return base.some((id, i) => id !== remote[i])
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((value, i) => value === b[i])

/**
 * Phase 1: what to delete, replace and add.
 *
 * @param {DraftItem[]} draft the pack as it should end up, in order
 * @param {string[]} remote file_unique_ids in the pack now
 * @returns {{deletes: string[], replaces: DraftItem[], adds: DraftItem[]}}
 */
function planContent (draft, remote) {
  const inPack = new Set(remote)
  const kept = new Set()

  for (const item of draft) {
    if (!item.fileUniqueId) continue
    if (!inPack.has(item.fileUniqueId)) throw new Error(`draft item ${item.assetId} points at ${item.fileUniqueId}, not in the pack`)
    if (kept.has(item.fileUniqueId)) throw new Error(`two draft items point at ${item.fileUniqueId}`)
    kept.add(item.fileUniqueId)
  }

  return {
    deletes: remote.filter((id) => !kept.has(id)),
    replaces: draft.filter((item) => item.fileUniqueId && item.file),
    adds: draft.filter((item) => !item.fileUniqueId)
  }
}

/**
 * The pack's file_unique_ids expected after phase 1, with the asset each
 * position holds — null where the sticker was replaced or added, since its
 * new id is unknown until getStickerSet.
 */
function expectAfterContent (draft, remote, content) {
  const deleted = new Set(content.deletes)
  const replaced = new Map(content.replaces.map((item) => [item.fileUniqueId, item.assetId]))
  const keptAsset = new Map(draft.filter((item) => item.fileUniqueId && !item.file).map((item) => [item.fileUniqueId, item.assetId]))

  const slots = remote
    .filter((id) => !deleted.has(id))
    .map((id) => replaced.has(id)
      ? { assetId: replaced.get(id), fileUniqueId: null }
      : { assetId: keptAsset.get(id), fileUniqueId: id })

  for (const item of content.adds) slots.push({ assetId: item.assetId, fileUniqueId: null })
  return slots
}

/**
 * Map every draft asset to its file_unique_id after phase 1. A kept sticker
 * is itself; the new ones are the stickers the pack holds besides the kept,
 * in the order phase 1 made them: a replaced sticker keeps its place, added
 * ones land at the end in the order they were added.
 *
 * A new sticker is not always a new id: the file a deleted sticker was made
 * from comes back as that very sticker. And a kept sticker may have moved: a
 * replace with a file already in the pack moves that sticker into place. So
 * kept stickers are found by id, not by position; the order is arrange's job.
 * Refuses when the pack doesn't hold exactly the kept stickers plus as many
 * new ones — someone changed it outside our lock, and guessing would attach
 * metadata or moves to the wrong sticker.
 *
 * @param {DraftItem[]} draft the items that are to be in the pack (without
 *   the ones Telegram merged into a sticker already there)
 * @param {string[]} remoteBefore file_unique_ids before phase 1
 * @param {Object} content result of planContent
 * @param {string[]} remoteAfter file_unique_ids from getStickerSet after phase 1
 * @returns {{ok: Map<string, string>} | {error: string}}
 */
function mapAfterContent (draft, remoteBefore, content, remoteAfter) {
  const slots = expectAfterContent(draft, remoteBefore, content)
  if (slots.length !== remoteAfter.length) {
    return { error: `expected ${slots.length} stickers, the pack has ${remoteAfter.length}` }
  }

  const kept = new Set(slots.filter((slot) => slot.fileUniqueId).map((slot) => slot.fileUniqueId))
  const inPack = new Set(remoteAfter)
  const missing = [...kept].find((id) => !inPack.has(id))
  if (missing) return { error: `${missing} is no longer in the pack` }

  // The counts match and every kept sticker is there, so the rest are
  // exactly the new ones.
  const fresh = remoteAfter.filter((id) => !kept.has(id))
  const map = new Map()
  let next = 0
  for (const slot of slots) map.set(slot.assetId, slot.fileUniqueId || fresh[next++])
  return { ok: map }
}

// Indexes (into `seq`) of one longest strictly increasing subsequence,
// O(n log n) patience sorting.
function longestIncreasing (seq) {
  const tails = []
  const prev = new Array(seq.length)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
  }
  const result = []
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) result.push(i)
  return result.reverse()
}

/**
 * Phase 2: setStickerPositionInSet calls that turn `current` into `target`.
 *
 * Telegram's semantics (measured): the sticker is taken out, then inserted
 * at `position` in what remains. Stickers on a longest increasing
 * subsequence of target positions never move; every other one is moved,
 * in target order, to just after its target predecessor. That is
 * n − LIS calls, the minimum — moving the last of 120 stickers to the
 * front is one call, not 120.
 *
 * @param {string[]} current file_unique_ids in the pack now
 * @param {string[]} target the same ids in the wanted order
 * @returns {{fileUniqueId: string, position: number}[]}
 */
function planMoves (current, target) {
  if (current.length !== target.length || !sameList([...current].sort(), [...target].sort())) {
    throw new Error('planMoves: current and target must hold the same stickers')
  }

  const targetIndex = new Map(target.map((id, i) => [id, i]))
  const stays = new Set(longestIncreasing(current.map((id) => targetIndex.get(id))).map((i) => current[i]))

  const order = [...current]
  const moves = []
  for (let i = 0; i < target.length; i++) {
    const id = target[i]
    if (stays.has(id)) continue
    order.splice(order.indexOf(id), 1)
    const position = i === 0 ? 0 : order.indexOf(target[i - 1]) + 1
    order.splice(position, 0, id)
    moves.push({ fileUniqueId: id, position })
  }
  return moves
}

/**
 * Phase 2: emoji list and keyword updates for stickers kept as they were.
 * Added and replaced stickers carry theirs in the InputSticker itself.
 *
 * @param {DraftItem[]} draft
 * @param {Map<string, {emojiList?: string[], keywords?: string[]}>} known
 *   what our database holds per file_unique_id; keywords undefined = unknown
 * @returns {{fileUniqueId: string, emojiList?: string[], keywords?: string[]}[]}
 */
function planMetadata (draft, known) {
  const updates = []
  for (const item of draft) {
    if (!item.fileUniqueId || item.file) continue
    const stored = known.get(item.fileUniqueId) || {}
    const update = { fileUniqueId: item.fileUniqueId }
    if (!sameList(item.emojiList, stored.emojiList)) update.emojiList = item.emojiList
    // An unknown stored value is written whenever the draft sets one: we
    // can't tell whether it differs, and setting it again is harmless.
    if (item.keywords !== undefined && (stored.keywords === undefined || !sameList(item.keywords, stored.keywords))) {
      update.keywords = item.keywords
    }
    if (update.emojiList || update.keywords) updates.push(update)
  }
  return updates
}

/**
 * Phase 3: the pack's own settings.
 *
 * @param {{title?: string, thumbnail?: {assetId?: string, fromSticker?: string}|null}} settings
 *   `thumbnail` null drops the custom thumbnail; `assetId` is an uploaded
 *   file (regular packs), `fromSticker` a file_unique_id of the pack (custom
 *   emoji packs, whose thumbnail is one of their emoji)
 * @returns {Object[]} steps; the title is still the user's, not yet formatted
 */
function planSettings (settings) {
  const steps = []
  if (settings.title !== undefined) steps.push({ kind: 'title', title: settings.title })
  if (settings.thumbnail !== undefined) {
    const { assetId, fromSticker } = settings.thumbnail || {}
    steps.push({ kind: 'thumbnail', ...(assetId ? { assetId } : {}), ...(fromSticker ? { fromSticker } : {}) })
  }
  return steps
}

module.exports = {
  hasConflict,
  planContent,
  mapAfterContent,
  planMoves,
  planMetadata,
  planSettings,
  longestIncreasing
}
