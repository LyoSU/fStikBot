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

// telegraf builds every request URL as `.../bot<token>/<method>` and node-fetch
// puts that URL into the message of every network-level error (ECONNRESET,
// ETIMEDOUT, …). That message used to reach the chat as "Telegram error:
// request to https://api.telegram.org/bot<token>/uploadStickerFile failed"
// (2026-10-27). retry-api strips it from every callApi error at the source;
// the sinks that show or store error text strip it again.
// A token anywhere: in a /bot<token>/ or /file/bot<token>/ path, or bare.
const BOT_TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/g
// A Mongo connection error can quote the URI, password included.
const MONGO_USERINFO_RE = /(mongodb(?:\+srv)?:\/\/)[^\s/@]+@/g

const redactBotToken = (text) => (
  typeof text === 'string'
    ? text.replace(BOT_TOKEN_RE, '<redacted>').replace(MONGO_USERINFO_RE, '$1<redacted>@')
    : text
)

// Mutates message/stack/description in place — the error object is what gets
// rethrown, shown and logged, so the copy has to be the one callers see.
const redactErrorToken = (error) => {
  if (!error || typeof error !== 'object') return error
  try {
    for (const key of ['message', 'stack', 'description']) {
      if (typeof error[key] === 'string') {
        const clean = redactBotToken(error[key])
        if (clean !== error[key]) error[key] = clean
      }
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

const humanizeTelegramError = (ctx, error) => {
  const reason = matchTelegramErrorReason(error)

  if (reason === 'rate_limited') {
    const seconds = extractRetryAfterSeconds(error)
    if (seconds) return ctx.i18n.t('error.rate_limit_seconds', { seconds })
    return ctx.i18n.t('error.telegram_reasons.rate_limited')
  }

  if (reason) return ctx.i18n.t(`error.telegram_reasons.${reason}`)

  // Raw text never reaches the user: a network error's message once carried
  // the bot token into the chat (2026-10-27). The cause is in the log.
  return ctx.i18n.t('error.unknown')
}

module.exports = {
  matchTelegramErrorReason,
  extractRetryAfterSeconds,
  humanizeTelegramError,
  redactBotToken,
  redactErrorToken
}
