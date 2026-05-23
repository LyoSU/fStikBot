const { buildSendCall } = require('./capture')

// Re-render a captured broadcast post into a target chat, using the same
// method/payload builder as the real dispatch. Used by:
//   - scenes/broadcast.js confirm step (operator preview before publishing)
//   - handlers/admin/messaging.js admin:messaging:view button
//
// No rate-limiting, no notification-flag overrides — this is the admin's
// own chat, the bot just shows them what users will receive.
const renderPreview = (telegram, chatId, message) => {
  const { method, payload } = buildSendCall({ message }, chatId)
  return telegram.callApi(method, payload)
}

module.exports = { renderPreview }
