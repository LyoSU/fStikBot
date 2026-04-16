const Telegram = require('telegraf/telegram')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wraps a Telegram API call with automatic retry on 429 rate limit errors.
 *
 * @param {Function} fn - The async function to execute
 * @param {Object} options - Options
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.maxWait - Maximum wait time in seconds (default: 60)
 * @returns {Promise} - Result of the function
 */
async function withRetry (fn, options = {}) {
  const { maxRetries = 3, maxWait = 60 } = options

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const retryAfter = error?.parameters?.retry_after

      if (retryAfter && attempt < maxRetries) {
        const waitTime = Math.min(retryAfter, maxWait)
        console.log(`[Retry] 429 Rate limit hit, waiting ${waitTime}s (attempt ${attempt + 1}/${maxRetries})`)
        await delay(waitTime * 1000)
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
 * (including ones created via `new Telegram()` outside of Telegraf) gets
 * automatic 429 retry handling. All ctx.reply*, ctx.editMessage*,
 * ctx.answerCbQuery, ctx.telegram.* calls funnel through callApi, so
 * wrapping it at the prototype level covers the entire surface.
 */
function patchTelegramPrototype () {
  if (!Telegram || !Telegram.prototype) return
  if (Telegram.prototype.__retryPatched) return

  const originalCallApi = Telegram.prototype.callApi

  Telegram.prototype.callApi = function patchedCallApi (...args) {
    return withRetry(() => originalCallApi.apply(this, args))
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
 * Middleware for Telegraf that exposes `ctx.withRetry` for manual use.
 *
 * Note: explicit wrapping of ctx.reply, ctx.editMessageText,
 * ctx.answerCbQuery, etc. is no longer needed — every one of those routes
 * through `ctx.telegram.callApi` which is now patched at the prototype level.
 */
function retryMiddleware () {
  return async (ctx, next) => {
    ctx.withRetry = (fn, options) => withRetry(fn, options)
    return next()
  }
}

module.exports = {
  withRetry,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware
}
