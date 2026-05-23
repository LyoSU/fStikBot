const replicators = require('telegraf/core/replicators')

// Re-render a captured broadcast post into a target chat — same payload
// shape send.js uses for real dispatch, just with the target chat swapped
// in. Used by:
//   - scenes/broadcast.js confirm step (operator preview before publishing)
//   - handlers/admin/messaging.js admin:messaging:view button
//
// Kept here (not in send.js) so admin preview doesn't accidentally inherit
// broadcast-policy overrides like rate limiting or notification flags.
const renderPreview = async (telegram, chatId, message) => {
  const method = replicators.copyMethods[message.type]
  if (!method) throw new Error(`Unsupported message type: ${message.type}`)

  const payload = {
    ...message.data,
    chat_id: chatId
  }
  if (message.replyMarkup) payload.reply_markup = message.replyMarkup

  return telegram.callApi(method, payload)
}

module.exports = { renderPreview }
