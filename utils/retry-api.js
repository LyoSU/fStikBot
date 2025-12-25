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
async function withRetry(fn, options = {}) {
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
function isRateLimitError(error) {
  return error?.code === 429 ||
         error?.response?.error_code === 429 ||
         error?.description?.includes('Too Many Requests')
}

/**
 * Get retry_after value from error
 */
function getRetryAfter(error) {
  return error?.parameters?.retry_after ||
         error?.response?.parameters?.retry_after ||
         null
}

/**
 * Middleware for Telegraf that adds retry capability to context
 */
function retryMiddleware() {
  return async (ctx, next) => {
    // Add retry helper to context
    ctx.withRetry = (fn, options) => withRetry(fn, options)

    // Wrap common reply methods with retry
    const originalReplyWithHTML = ctx.replyWithHTML?.bind(ctx)
    if (originalReplyWithHTML) {
      ctx.replyWithHTML = (...args) => withRetry(() => originalReplyWithHTML(...args))
    }

    const originalReply = ctx.reply?.bind(ctx)
    if (originalReply) {
      ctx.reply = (...args) => withRetry(() => originalReply(...args))
    }

    const originalReplyWithPhoto = ctx.replyWithPhoto?.bind(ctx)
    if (originalReplyWithPhoto) {
      ctx.replyWithPhoto = (...args) => withRetry(() => originalReplyWithPhoto(...args))
    }

    const originalReplyWithDocument = ctx.replyWithDocument?.bind(ctx)
    if (originalReplyWithDocument) {
      ctx.replyWithDocument = (...args) => withRetry(() => originalReplyWithDocument(...args))
    }

    const originalReplyWithSticker = ctx.replyWithSticker?.bind(ctx)
    if (originalReplyWithSticker) {
      ctx.replyWithSticker = (...args) => withRetry(() => originalReplyWithSticker(...args))
    }

    const originalEditMessageText = ctx.editMessageText?.bind(ctx)
    if (originalEditMessageText) {
      ctx.editMessageText = (...args) => withRetry(() => originalEditMessageText(...args))
    }

    const originalEditMessageReplyMarkup = ctx.editMessageReplyMarkup?.bind(ctx)
    if (originalEditMessageReplyMarkup) {
      ctx.editMessageReplyMarkup = (...args) => withRetry(() => originalEditMessageReplyMarkup(...args))
    }

    const originalAnswerCbQuery = ctx.answerCbQuery?.bind(ctx)
    if (originalAnswerCbQuery) {
      ctx.answerCbQuery = (...args) => withRetry(() => originalAnswerCbQuery(...args), { maxRetries: 1 })
    }

    return next()
  }
}

module.exports = {
  withRetry,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware
}
