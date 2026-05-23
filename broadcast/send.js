const replicators = require('telegraf/core/replicators')
const telegram = require('../utils/telegram').get(process.env.MAIN_BOT_TOKEN)

// True 1:1 message copy.
//
// `replicators.copyMethods[type]` resolves the appropriate Bot API method
// (sendMessage / sendPhoto / sendVideo / sendAnimation / sendDocument /
// sendAudio / sendVoice / sendVideoNote / sendSticker / sendDice / sendPoll
// / sendLocation / sendVenue / sendContact) and `replicators[type](msg)`
// extracts the exact payload (text, media, caption, entities, parse_mode,
// link_preview_options, …).
//
// We override exactly one thing:
//   - chat_id        — pointed at the current recipient
//   - reply_markup   — original inline keyboard from the source post,
//                      passed through verbatim so Bot API 9.4 `style` /
//                      `icon_custom_emoji_id` and 9.0 `copy_text` buttons
//                      just work; URL/web_app/login_url buttons survive
//                      forwarding (only callback_data ones are stripped by
//                      Telegram, which is what we want anyway)
//
// Everything else (entities, link preview options, parse_mode, notification
// flag, protect_content, …) comes straight from the captured source — no
// overrides, no surprises, no policy.
//
// Note on `forwardMessage`: deliberately not supported. Mass-forwarding hits
// stricter Telegram limits than copyMessage/send* and is not appropriate for
// broadcasts.

// Bounded retry for short 429s. Longer waits surface to the runner which
// pauses the campaign — see broadcast/runner.js.
const SHORT_RETRY_AFTER_S = parseInt(process.env.BROADCAST_SHORT_RETRY_AFTER_S, 10) || 30
const MAX_RETRIES = 2

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const buildCall = (broadcast, chatId) => {
  const { type, data, replyMarkup } = broadcast.message
  const method = replicators.copyMethods[type]
  if (!method) throw new Error(`Unsupported message type: ${type}`)

  const payload = {
    ...data,
    chat_id: chatId
  }
  if (replyMarkup) payload.reply_markup = replyMarkup

  return { method, payload }
}

const sendToRecipient = async (broadcast, chatId) => {
  const { method, payload } = buildCall(broadcast, chatId)

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
