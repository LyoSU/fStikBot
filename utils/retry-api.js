// Telegram API retry + transient-403 short-circuit, patched at the
// Telegram.prototype level so every `ctx.reply*`, `ctx.editMessage*`,
// `ctx.telegram.*` call inherits the behavior automatically.
//
// Two problems this solves:
//   1. 429 rate limits — retries with jitter if retry_after is short
//      enough to tolerate in a handler; otherwise fails fast. Long waits
//      belong in a background Bull queue (utils/queues.js), not in a
//      Telegraf handler slot, because the polling batch has a finite
//      handlerTimeout and 29k+ pending updates is what happens when one
//      rate-limited user parks a handler for 44s.
//   2. 403 cascades — when a user blocks the bot, any subsequent reply
//      (error-handler fallback, scene-level "something went wrong"
//      follow-up, etc.) also 403s. We cache the chat_id briefly so the
//      second/third/Nth attempt short-circuits with a synthetic 403,
//      without hitting the network.
//
// Design principle: no hardcoded method names or error-description
// strings. Uniform rules driven by payload shape and HTTP semantics.
const Telegram = require('telegraf/telegram')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ────────────────────────────────────────────────────────────────
// Tunables — env-configurable so ops can tweak without a redeploy.
// Defaults are what we actually want in prod for a bot at ~40 rps.
// ────────────────────────────────────────────────────────────────
const RETRY_MAX_WAIT_S = parseInt(process.env.RETRY_MAX_WAIT_S, 10) || 5
const RETRY_MAX_ATTEMPTS = parseInt(process.env.RETRY_MAX_ATTEMPTS, 10) || 3
const BLOCKED_CACHE_TTL_MS = parseInt(process.env.BLOCKED_CACHE_TTL_MS, 10) || 60 * 1000
const BLOCKED_CACHE_MAX = parseInt(process.env.BLOCKED_CACHE_MAX, 10) || 10000
const RETRY_JITTER_MAX_MS = parseInt(process.env.RETRY_JITTER_MAX_MS, 10) || 1500

// ────────────────────────────────────────────────────────────────
// Blocked-chat cache
// ────────────────────────────────────────────────────────────────
// Any call with a chat_id or user_id that returns 403 caches that id
// for a short TTL. Subsequent targeted calls to the same id short-
// circuit with a synthetic 403 instead of hitting the network. The
// retry middleware clears the cache as soon as we see an incoming
// update from that chat — so a user who unblocks and writes back gets
// replies immediately, no TTL wait.
const blockedChats = new Map()

function cacheBlocked (chatId) {
  if (!chatId) return
  // LRU-ish eviction: when full, drop the oldest ~10%. Map iterates in
  // insertion order so this is O(k) without a separate heap.
  if (blockedChats.size >= BLOCKED_CACHE_MAX) {
    const toRemove = Math.floor(BLOCKED_CACHE_MAX * 0.1)
    const it = blockedChats.keys()
    for (let i = 0; i < toRemove; i++) {
      const key = it.next().value
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

function clearBlockedChat (chatId) {
  if (!chatId) return
  blockedChats.delete(chatId)
}

function buildBlockedError (chatId, method) {
  const err = new Error(`Forbidden: cached 403 for chat_id=${chatId} (${method})`)
  err.code = 403
  err.description = 'Forbidden: bot was blocked by the user'
  err.on = { method }
  err.__cachedBlock = true
  return err
}

// Any payload that has a chat_id or user_id is "targeted" at a specific
// chat. We don't look at method names — if Telegram routes it to a
// specific chat, the cache applies.
function targetChatId (data) {
  if (!data || typeof data !== 'object') return null
  return data.chat_id || data.user_id || null
}

// ────────────────────────────────────────────────────────────────
// Retry
// ────────────────────────────────────────────────────────────────

/**
 * Wrap a Telegram API call with 429 retry. Uniform rule for all methods:
 *   - retry_after > maxWait → throw immediately (fail fast, let caller
 *     decide. Long waits belong in a background queue.)
 *   - retry_after ≤ maxWait → retry up to maxRetries with jitter
 *
 * Default maxWait is short (5s) because we're assumed to be in a
 * Telegraf handler. Background workers (Bull consumers) should pass
 * a longer maxWait and higher maxRetries — they're not in the polling
 * batch so they can afford to wait.
 *
 * @param {Function} fn
 * @param {Object}   [options]
 * @param {number}   [options.maxRetries=3]
 * @param {number}   [options.maxWait=5]   seconds
 * @param {string}   [options.method]      for logs
 */
async function withRetry (fn, options = {}) {
  const {
    maxRetries = RETRY_MAX_ATTEMPTS,
    maxWait = RETRY_MAX_WAIT_S,
    method = 'unknown'
  } = options

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const retryAfter = getRetryAfter(error)

      if (!retryAfter) throw error

      if (retryAfter > maxWait) {
        console.log(
          `[Retry] 429 on ${method}, retry_after=${retryAfter}s > maxWait=${maxWait}s — failing fast`
        )
        throw error
      }

      if (attempt >= maxRetries) throw error

      const waitMs = retryAfter * 1000 + Math.floor(Math.random() * RETRY_JITTER_MAX_MS)
      console.log(
        `[Retry] 429 on ${method}, waiting ${(waitMs / 1000).toFixed(1)}s ` +
        `(attempt ${attempt + 1}/${maxRetries})`
      )
      await delay(waitMs)
    }
  }
  // Unreachable — the loop either returns or throws. Explicit throw
  // makes control flow obvious to readers and linters.
  throw new Error('withRetry: exhausted retries without result')
}

// ────────────────────────────────────────────────────────────────
// Error helpers
// ────────────────────────────────────────────────────────────────

function isRateLimitError (error) {
  return error?.code === 429 ||
         error?.response?.error_code === 429 ||
         /too many requests/i.test(error?.description || '') ||
         /too many requests/i.test(error?.response?.description || '')
}

function getRetryAfter (error) {
  return error?.parameters?.retry_after ||
         error?.response?.parameters?.retry_after ||
         null
}

// ────────────────────────────────────────────────────────────────
// Prototype patch — install retry + blocked-cache on every Telegram
// instance. One-shot, non-reentrant.
// ────────────────────────────────────────────────────────────────

function patchTelegramPrototype () {
  if (!Telegram || !Telegram.prototype) return
  if (Telegram.prototype.__retryPatched) return

  const originalCallApi = Telegram.prototype.callApi

  Telegram.prototype.callApi = function patchedCallApi (method, data = {}, ...rest) {
    const chatId = targetChatId(data)

    // Short-circuit: recently-seen 403 for this chat_id/user_id.
    if (chatId && isBlockedCached(chatId)) {
      return Promise.reject(buildBlockedError(chatId, method))
    }

    return withRetry(
      () => originalCallApi.call(this, method, data, ...rest),
      { method }
    ).catch((error) => {
      // 403 on a private chat (positive id = user_id / DM chat_id) →
      // cache briefly: "blocked by user", "user deactivated", "chat not
      // found". Groups/supergroups have negative ids and 403 there is
      // usually "not enough rights" (bot demoted) — caching would
      // silently skip all sends for TTL, so we skip groups entirely.
      if (error?.code === 403 && chatId > 0) cacheBlocked(chatId)
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

// ────────────────────────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────────────────────────

// Exposes ctx.withRetry for manual wrapping (e.g. explicit retry around
// a non-Telegraf async call) and clears the blocked-chat cache the
// moment we see an update from that chat — so users who unblock don't
// have to wait out the TTL.
function retryMiddleware () {
  return async (ctx, next) => {
    ctx.withRetry = (fn, options) => withRetry(fn, options)

    const mcm = ctx?.update?.my_chat_member
    const isKick = mcm?.new_chat_member?.status === 'kicked'

    if (ctx.from?.id && !isKick) clearBlockedChat(ctx.from.id)
    if (ctx.chat?.id && ctx.chat.id !== ctx.from?.id && !isKick) {
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
  _blockedCacheSize: () => blockedChats.size
}
