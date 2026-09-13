// Shared 429 cooldown for the sticker-creation pipeline.
//
// Adding one sticker is two rate-limited calls under the owner's user_id:
// uploadStickerFile (messages.uploadMedia) and addStickerToSet /
// createNewStickerSet. retry-api caches each (method, user_id) cooldown on its
// own, so checking only addStickerToSet let a user whose uploadStickerFile was
// in cooldown re-download and re-upload the file on every attempt — deepening
// the very flood wait they were stuck in.
const { getRateLimitRemaining } = require('./retry-api')

const STICKER_METHODS = ['uploadStickerFile', 'addStickerToSet', 'createNewStickerSet']

/**
 * Longest remaining cooldown (seconds) across the sticker-creation methods
 * for this user, or 0 when none is active.
 *
 * @param {number} userId
 * @returns {number}
 */
function getStickerCooldown (userId) {
  return Math.max(0, ...STICKER_METHODS.map((method) => getRateLimitRemaining(method, userId)))
}

/**
 * A 429-shaped error for a cooldown we already know about, so callers can
 * route it through the same rendering as a real Telegram 429
 * (matchTelegramErrorReason / extractRetryAfterSeconds).
 *
 * @param {number} seconds
 * @returns {Error}
 */
function buildCooldownError (seconds) {
  const err = new Error(`Too Many Requests: retry after ${seconds}`)
  err.code = 429
  err.description = err.message
  err.parameters = { retry_after: seconds }
  err.__cachedRateLimit = true
  return err
}

module.exports = {
  getStickerCooldown,
  buildCooldownError
}
