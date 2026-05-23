const telegram = require('../utils/telegram').get(process.env.MAIN_BOT_TOKEN)
const { buildSendCall } = require('./capture')

// True 1:1 message dispatch.
//
// Method + payload are built by broadcast/capture.js, which deliberately
// avoids `parse_mode: 'HTML'` round-trip and passes `entities` /
// `caption_entities` straight through. That makes custom_emoji, blockquote,
// expandable_blockquote, spoiler — and any future entity types — survive
// intact, which the Telegraf-3 replicators do not.
//
// reply_markup from the source post is preserved verbatim, so URL /
// copy_text / web_app / Bot API 9.4 styled buttons all just work. (Only
// callback_data buttons get stripped by Telegram when the operator forwards
// the post into the bot — which is what we want anyway.)
//
// Note: `forwardMessage` is deliberately not supported. Mass-forwarding hits
// stricter Telegram limits than send* and is not appropriate for broadcasts.

// Bounded retry for short 429s. Longer waits surface to the runner which
// pauses the campaign — see broadcast/runner.js.
const SHORT_RETRY_AFTER_S = parseInt(process.env.BROADCAST_SHORT_RETRY_AFTER_S, 10) || 30
const MAX_RETRIES = 2

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sendToRecipient = async (broadcast, chatId) => {
  const { method, payload } = buildSendCall(broadcast, chatId)

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await telegram.callApi(method, payload)
    } catch (err) {
      const retryAfter = err && err.parameters && err.parameters.retry_after
      const canRetry = retryAfter && retryAfter <= SHORT_RETRY_AFTER_S && attempt <= MAX_RETRIES
      if (!canRetry) throw err
      await delay((retryAfter + 1) * 1000)
    }
  }
}

module.exports = { sendToRecipient }
