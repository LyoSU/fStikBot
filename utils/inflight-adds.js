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

// key → { expiresAt, token }. The token makes release() free only the claim
// it was given: a late release (a job that outlived its TTL) must not free a
// newer claim on the same file.
const claims = new Map()
let seq = 0

const keyOf = (packId, sourceUid) => (packId && sourceUid ? `${packId}:${sourceUid}` : null)

function sweep (now) {
  for (const [key, claim] of claims) {
    if (claim.expiresAt <= now) claims.delete(key)
  }
}

/**
 * Take the (pack, file) slot.
 *
 * @param {*} packId
 * @param {string} sourceUid file_unique_id of the file the user sent
 * @returns {string|null|false} the claim to release later (key#token); null when there
 *   is nothing to key on (no claim needed); false when the same file is
 *   already being added to this pack
 */
function claim (packId, sourceUid, { now = Date.now(), ttlMs = TTL_MS } = {}) {
  const key = keyOf(packId, sourceUid)
  if (!key) return null

  const held = claims.get(key)
  if (held && held.expiresAt > now) return false

  if (claims.size >= MAX_ENTRIES) sweep(now)
  const token = String(++seq)
  claims.set(key, { expiresAt: now + ttlMs, token })
  return `${key}#${token}`
}

/** Free a slot taken by claim(). Unknown, empty or outdated claims are ignored. */
function release (claimed) {
  if (!claimed) return
  const at = claimed.lastIndexOf('#')
  if (at < 0) return
  const key = claimed.slice(0, at)
  if (claims.get(key)?.token === claimed.slice(at + 1)) claims.delete(key)
}

module.exports = { claim, release, TTL_MS, _size: () => claims.size, _clear: () => claims.clear() }
