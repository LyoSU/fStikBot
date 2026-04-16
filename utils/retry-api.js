const Telegram = require('telegraf/telegram')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ===================
// BLOCKED-CHAT CACHE
// ===================
//
// Short-lived in-memory cache of chat_ids that just returned a terminal
// "we can't reach this chat" 403. Prevents a single blocked user from
// triggering a cascade of N more API calls in the same handler (error
// reply → global catch → etc.) which in turn contributes to per-chat
// rate limits on unrelated traffic.
//
// TTL is intentionally short: if the user unblocks or a stale entry is
// wrong, the worst case is one extra 403 after the TTL expires. The
// cache is also proactively cleared in middleware when ANY update
// arrives from that chat (see bot/middleware.js) — so in practice the
// TTL only matters for chats that stop talking to us entirely.
const BLOCKED_CACHE_TTL_MS = 60 * 1000
const BLOCKED_CACHE_MAX = 10000

const blockedChats = new Map()

const SEND_METHODS = new Set([
  'sendMessage', 'sendPhoto', 'sendVideo', 'sendSticker', 'sendDocument',
  'sendAnimation', 'sendAudio', 'sendVoice', 'sendVideoNote', 'sendMediaGroup',
  'sendLocation', 'sendVenue', 'sendContact', 'sendDice', 'sendPoll',
  'sendInvoice', 'sendChatAction', 'copyMessage', 'forwardMessage',
  'editMessageText', 'editMessageCaption', 'editMessageReplyMarkup',
  'editMessageMedia', 'editMessageLiveLocation', 'stopMessageLiveLocation',
  'deleteMessage'
])

const BLOCKED_DESCRIPTIONS = [
  'blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot was kicked'
]

function isBlockedDescription (description) {
  if (!description) return false
  return BLOCKED_DESCRIPTIONS.some(needle => description.includes(needle))
}

function cacheBlocked (chatId) {
  if (!chatId) return
  // LRU-ish eviction: drop oldest ~10% when full. Map iterates in
  // insertion order, so this is O(k) and we don't need a separate heap.
  if (blockedChats.size >= BLOCKED_CACHE_MAX) {
    const toRemove = Math.floor(BLOCKED_CACHE_MAX * 0.1)
    const iterator = blockedChats.keys()
    for (let i = 0; i < toRemove; i++) {
      const key = iterator.next().value
      if (key === undefined) break
      blockedChats.delete(key)
    }
  }
  blockedChats.set(chatId, Date.now() + BLOCKED_CACHE_TTL_MS)
}

function isBlockedCached (chatId) {
  if (!chatId) return false
  const expiresAt = blockedChats.get(chatId)
  if (!expiresAt) return false
  if (expiresAt < Date.now()) {
    blockedChats.delete(chatId)
    return false
  }
  return true
}

/**
 * Middleware clears this when we see the user is reachable again.
 */
function clearBlockedChat (chatId) {
  if (!chatId) return
  blockedChats.delete(chatId)
}

function buildBlockedError (chatId, method) {
  const err = new Error(`Forbidden: bot was blocked by the user (cached for chat_id=${chatId})`)
  err.code = 403
  err.description = 'Forbidden: bot was blocked by the user'
  err.on = { method }
  err.__cachedBlock = true
  return err
}

// ===================
// RETRY
// ===================

// Methods with heavy per-resource rate limits (per sticker-pack, per-user
// pack quota, etc.) that don't recover in seconds — retrying just blocks
// the handler slot without helping. Fail fast so the caller can surface
// an error to the user and the polling queue keeps draining.
const NO_RETRY_METHODS = new Set([
  'addStickerToSet',
  'createNewStickerSet',
  'deleteStickerFromSet',
  'replaceStickerInSet',
  'setStickerPositionInSet',
  'setStickerSetTitle',
  'setStickerSetThumbnail',
  'setCustomEmojiStickerSetThumbnail',
  'setStickerEmojiList',
  'setStickerKeywords',
  'setStickerMaskPosition',
  'uploadStickerFile'
])

// Default maxWait is short on purpose. If Telegram tells us to wait
// longer than this, we throw 429 immediately and let the caller decide
// (usually bot.catch replies with a localized rate-limit message). The
// previous 60s cap meant one bursty user's flood could park a handler
// slot for up to 3×60=180s, which at polling-batch scale grew the
// pending-update queue to 29k+ updates.
const DEFAULT_MAX_WAIT_S = 5

/**
 * Wraps a Telegram API call with retry on 429 rate limit errors.
 *
 * Retry policy:
 *   - If method is in NO_RETRY_METHODS → throw immediately on 429
 *   - If retry_after > maxWait → throw immediately (Telegram is telling
 *     us to wait longer than we're willing to block for)
 *   - Else retry up to maxRetries times with jitter
 *
 * @param {Function} fn - The async function to execute
 * @param {Object} options
 * @param {number} options.maxRetries - Max retry attempts (default: 3)
 * @param {number} options.maxWait - Max seconds to wait between retries
 *                                   (default: 5). Above this, fail fast.
 * @param {string} options.method - Telegram method name (for logs)
 * @returns {Promise}
 */
async function withRetry (fn, options = {}) {
  const { maxRetries = 3, maxWait = DEFAULT_MAX_WAIT_S, method = 'unknown' } = options

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const retryAfter = error?.parameters?.retry_after

      // Heavy per-resource methods: don't retry, ever. Fail fast.
      if (retryAfter && NO_RETRY_METHODS.has(method)) {
        console.log(`[Retry] 429 on ${method} (no-retry method), retry_after=${retryAfter}s → failing fast`)
        throw error
      }

      // Telegram says wait longer than we'll tolerate: fail fast.
      if (retryAfter && retryAfter > maxWait) {
        console.log(`[Retry] 429 on ${method}, retry_after=${retryAfter}s exceeds maxWait=${maxWait}s → failing fast`)
        throw error
      }

      if (retryAfter && attempt < maxRetries) {
        // Jitter breaks the thundering herd: when many handlers hit 429
        // together, Telegram tells them all to wait the same amount.
        // Without jitter they'd all retry simultaneously and likely
        // trip the limit again. 0–1500ms spread is enough to fan out
        // the retry wave without adding meaningful latency.
        const baseMs = retryAfter * 1000
        const jitterMs = Math.floor(Math.random() * 1500)
        const waitMs = baseMs + jitterMs
        console.log(
          `[Retry] 429 on ${method}, waiting ${(waitMs / 1000).toFixed(1)}s ` +
          `(attempt ${attempt + 1}/${maxRetries})`
        )
        await delay(waitMs)
        continue
      }

      throw error
    }
  }
}

/**
 * Check if error is a 429 rate limit error
 */
function isRateLimitError (error) {
  return error?.code === 429 ||
         error?.response?.error_code === 429 ||
         /too many requests/i.test(error?.description || '') ||
         /too many requests/i.test(error?.response?.description || '')
}

/**
 * Get retry_after value from error
 */
function getRetryAfter (error) {
  return error?.parameters?.retry_after ||
         error?.response?.parameters?.retry_after ||
         null
}

/**
 * Patch Telegram.prototype.callApi once so every Telegram instance
 * (including ones created via `new Telegram()` outside of Telegraf) gets:
 *   - automatic 429 retry with jitter
 *   - blocked-chat short-circuit (skip sendMessage et al. to chats that
 *     just returned "Forbidden: bot was blocked by the user")
 *
 * All ctx.reply*, ctx.editMessage*, ctx.answerCbQuery, ctx.telegram.*
 * calls funnel through callApi, so wrapping it at the prototype level
 * covers the entire surface.
 */
function patchTelegramPrototype () {
  if (!Telegram || !Telegram.prototype) return
  if (Telegram.prototype.__retryPatched) return

  const originalCallApi = Telegram.prototype.callApi

  Telegram.prototype.callApi = function patchedCallApi (method, data = {}, ...rest) {
    // For private chats, chat_id === user_id (same integer), so caching
    // a user_id from e.g. createNewStickerSet correctly short-circuits
    // a follow-up sendMessage to the same person. This identity doesn't
    // hold for groups/channels, but no Telegram send-method takes a
    // bare `user_id` in those contexts — so the collision is impossible.
    const chatId = data && (data.chat_id || data.user_id)

    if (chatId && SEND_METHODS.has(method) && isBlockedCached(chatId)) {
      return Promise.reject(buildBlockedError(chatId, method))
    }

    return withRetry(
      () => originalCallApi.call(this, method, data, ...rest),
      { method }
    ).catch((error) => {
      if (error?.code === 403 && chatId && isBlockedDescription(error.description)) {
        cacheBlocked(chatId)
      }
      throw error
    })
  }

  Object.defineProperty(Telegram.prototype, '__retryPatched', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  })
}

patchTelegramPrototype()

/**
 * Middleware for Telegraf that exposes `ctx.withRetry` for manual use
 * and clears the blocked-chat cache on any incoming update from a user.
 *
 * The cache-clear is the fast path for unblock: as soon as the user
 * sends anything (or interacts via callback/inline), we know they can
 * receive messages again — no need to wait out the TTL.
 */
function retryMiddleware () {
  return async (ctx, next) => {
    ctx.withRetry = (fn, options) => withRetry(fn, options)

    // my_chat_member arriving with status !== 'kicked' already clears
    // the user.blocked flag in updateUser; we mirror that here for the
    // in-memory cache. Skip kicked events — those confirm the block.
    const mcm = ctx?.update?.my_chat_member
    const isKick = mcm?.new_chat_member?.status === 'kicked'

    if (ctx.from && ctx.from.id && !isKick) {
      clearBlockedChat(ctx.from.id)
    }
    if (ctx.chat && ctx.chat.id && ctx.chat.id !== ctx.from?.id && !isKick) {
      clearBlockedChat(ctx.chat.id)
    }

    return next()
  }
}

module.exports = {
  withRetry,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware,
  clearBlockedChat,
  // Exposed for diagnostics / tests
  _blockedCacheSize: () => blockedChats.size
}
