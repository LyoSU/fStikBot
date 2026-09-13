// Maps Telegram API errors to user-facing i18n keys under
// `error.telegram_reasons.*`. Patterns are ordered most-specific
// (longer / unambiguous identifier) → most-generic.

const ERROR_PATTERNS = [
  { match: /STICKER_INVALID|STICKER_NOT_FOUND/i, reason: 'sticker_not_in_set' },
  { match: /STICKERSET_INVALID|STICKERSET_NOT_FOUND/i, reason: 'pack_invalid' },
  { match: /STICKERS_TOO_MUCH/i, reason: 'pack_full' },
  { match: /STICKERSET_OWNER_ANOTHER/i, reason: 'not_pack_owner' },
  { match: /sticker set name is already occupied/i, reason: 'pack_name_taken' },
  { match: /PACK_SHORT_NAME_INVALID/i, reason: 'pack_name_invalid' },
  { match: /STICKER_PNG_NOPNG|STICKER_PNG_DIMENSIONS|STICKER_TGS_NOTGS|STICKER_VIDEO_NOWEBM|STICKER_VIDEO_BIG|STICKER_FILE_INVALID|STICKER_DOCUMENT_INVALID/i, reason: 'invalid_sticker_format' },
  { match: /STICKER_EMOJI_INVALID|EMOJI_INVALID/i, reason: 'invalid_emoji' },
  { match: /Too Many Requests|FLOOD_WAIT/i, reason: 'rate_limited' },
  { match: /^Forbidden|bot was blocked|user is deactivated|chat not found|PEER_ID_INVALID/i, reason: 'cannot_reach_user' }
]

const RATE_LIMIT_CODE = 429

// Telegram error descriptions are usually short, but rare 400s come back
// with a multi-kilobyte JSON dump. We render this string into i18n
// templates that may feed answerCbQuery (200-char hard limit) or
// replyWithHTML (4096-char limit). Clamp at the source so the sink
// can't blow up with MESSAGE_TOO_LONG.
const truncateDescription = (s, max) => (
  s.length > max ? `${s.slice(0, max - 1)}…` : s
)
// Default fits answerCbQuery (200) once the i18n template wraps it in
// "Telegram error: <code>…</code>" (~30 chars of prefix/suffix).
const DEFAULT_MAX_DESCRIPTION_LEN = 150

// telegraf builds every request URL as `.../bot<token>/<method>` and node-fetch
// puts that URL into the message of every network-level error (ECONNRESET,
// ETIMEDOUT, …). Strip the token before such text reaches a log or the admin
// log channel.
const BOT_TOKEN_RE = /\/bot\d+:[A-Za-z0-9_-]+\//g

const redactBotToken = (text) => (
  typeof text === 'string' ? text.replace(BOT_TOKEN_RE, '/bot<redacted>/') : text
)

// Mutates message/stack in place — the error object is what gets rethrown
// and eventually logged, so the copy has to be the one callers see.
const redactErrorToken = (error) => {
  if (!error || typeof error !== 'object') return error
  try {
    if (typeof error.message === 'string' && BOT_TOKEN_RE.test(error.message)) {
      error.message = redactBotToken(error.message)
    }
    if (typeof error.stack === 'string' && BOT_TOKEN_RE.test(error.stack)) {
      error.stack = redactBotToken(error.stack)
    }
  } catch (_) { /* frozen error object — nothing to do */ }
  return error
}

const matchTelegramErrorReason = (error) => {
  if (!error) return null
  if (error.code === RATE_LIMIT_CODE) return 'rate_limited'
  const description = error.description || error.message || ''
  for (const { match, reason } of ERROR_PATTERNS) {
    if (match.test(description)) return reason
  }
  return null
}

const extractRetryAfterSeconds = (error) => {
  if (!error) return null
  // Telegram attaches `parameters.retry_after` on 429.
  const fromParams = error.parameters?.retry_after ?? error.response?.parameters?.retry_after
  if (Number.isFinite(fromParams)) return fromParams
  const description = error.description || error.message || ''
  const match = description.match(/FLOOD_WAIT_(\d+)/i) || description.match(/retry after (\d+)/i)
  return match ? parseInt(match[1], 10) : null
}

const humanizeTelegramError = (ctx, error, opts = {}) => {
  const reason = matchTelegramErrorReason(error)

  if (reason === 'rate_limited') {
    const seconds = extractRetryAfterSeconds(error)
    if (seconds) return ctx.i18n.t('error.rate_limit_seconds', { seconds })
    return ctx.i18n.t('error.telegram_reasons.rate_limited')
  }

  if (reason) return ctx.i18n.t(`error.telegram_reasons.${reason}`)

  const description = error?.description || error?.message || 'Unknown error'
  const maxLen = opts.maxDescriptionLen || DEFAULT_MAX_DESCRIPTION_LEN
  return ctx.i18n.t(opts.fallbackKey || 'error.telegram', {
    error: truncateDescription(description, maxLen)
  })
}

module.exports = {
  matchTelegramErrorReason,
  extractRetryAfterSeconds,
  humanizeTelegramError,
  truncateDescription,
  redactBotToken,
  redactErrorToken
}
