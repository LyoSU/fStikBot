// Classify a Telegram Bot API error into a small, bounded set of codes that
// the runner uses to (a) decide per-recipient action (mark blocked, pause
// campaign, just count), and (b) aggregate stats by category instead of
// keeping unbounded raw error strings.

const CODE = Object.freeze({
  BLOCKED: 'blocked', // bot was blocked by the user
  DEACTIVATED: 'deactivated', // user account deactivated/deleted
  CHAT_NOT_FOUND: 'chat_not_found',
  RATE_LIMIT: 'rate_limit', // 429 — retry handled in send.js for short waits
  MEDIA_INVALID: 'media_invalid', // file_id expired, wrong type, file too big
  FORBIDDEN: 'forbidden', // other 403 (e.g. user privacy settings)
  OTHER: 'other'
})

// Codes that mean "this recipient is unreachable, mark User.blocked = true".
const SOFT_BAN_CODES = new Set([CODE.BLOCKED, CODE.DEACTIVATED, CODE.CHAT_NOT_FOUND])

// Codes that halt the campaign entirely.
const PAUSE_CODES = new Set([CODE.MEDIA_INVALID])

const classify = (err) => {
  if (!err) return CODE.OTHER

  if (err.parameters && typeof err.parameters.retry_after === 'number') {
    return CODE.RATE_LIMIT
  }

  const desc = String(err.description || err.message || '').toLowerCase()

  if (/bot was blocked by the user/.test(desc)) return CODE.BLOCKED
  if (/user is deactivated/.test(desc)) return CODE.DEACTIVATED
  if (/chat not found|chat_id is empty|peer_id_invalid/.test(desc)) return CODE.CHAT_NOT_FOUND
  if (/wrong file_id|wrong type|file is too big|wrong remote file|wrong character/.test(desc)) {
    return CODE.MEDIA_INVALID
  }
  if (err.code === 403 || /forbidden/.test(desc)) return CODE.FORBIDDEN

  return CODE.OTHER
}

const isSoftBan = (code) => SOFT_BAN_CODES.has(code)
const isPauseTrigger = (code) => PAUSE_CODES.has(code)

const describe = (err) => {
  if (!err) return 'unknown'
  const raw = err.description || err.message || 'unknown'
  return String(raw).slice(0, 300)
}

module.exports = { CODE, classify, isSoftBan, isPauseTrigger, describe }
