// Files being added to a pack right now, by (pack, source file).
//
// The duplicate check in handlers/sticker.js looks at the stickers table, and
// a video only gets its row once the converter is done with it — minutes
// later on a busy evening. A user who saw nothing happen sent the same video
// again, it passed the check and the pack got it twice (prod 2026-11-17:
// ~170 such video/GIF duplicates a day). A claim covers that window: it is
// taken before the check and held until the add is finished, conversion
// included.
//
// In memory, like utils/user-queue.js: the bot is one process. A claim the
// process never releases (a lost convert event) expires on its own, so the
// worst case is the old behaviour, never a file refused for good.
const TTL_MS = parseInt(process.env.INFLIGHT_ADD_TTL_MS, 10) || 30 * 60 * 1000
const MAX_ENTRIES = 50000

const claims = new Map()

const keyOf = (packId, sourceUid) => (packId && sourceUid ? `${packId}:${sourceUid}` : null)

function sweep (now) {
  for (const [key, expiresAt] of claims) {
    if (expiresAt <= now) claims.delete(key)
  }
}

/**
 * Take the (pack, file) slot.
 *
 * @param {*} packId
 * @param {string} sourceUid file_unique_id of the file the user sent
 * @returns {string|null|false} the claim key to release later; null when there
 *   is nothing to key on (no claim needed); false when the same file is
 *   already being added to this pack
 */
function claim (packId, sourceUid, { now = Date.now(), ttlMs = TTL_MS } = {}) {
  const key = keyOf(packId, sourceUid)
  if (!key) return null

  const expiresAt = claims.get(key)
  if (expiresAt && expiresAt > now) return false

  if (claims.size >= MAX_ENTRIES) sweep(now)
  claims.set(key, now + ttlMs)
  return key
}

/** Free a slot taken by claim(). Unknown or empty keys are ignored. */
function release (key) {
  if (key) claims.delete(key)
}

module.exports = { claim, release, TTL_MS, _size: () => claims.size, _clear: () => claims.clear() }
