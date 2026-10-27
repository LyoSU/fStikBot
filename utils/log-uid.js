const crypto = require('node:crypto')

// A Telegram user as a short keyed hash, for counting users and following one
// through a funnel in the logs without the id itself. The API hashes the same
// way (fstikbot-api utils/log-uid.js) with the same LOG_UID_SALT, so an API
// line and a bot line of one user share a `uid`. No salt, no uid: an unsalted
// hash of a Telegram id is undone by trying every id.
function logUid (telegramId) {
  const salt = process.env.LOG_UID_SALT
  if (!salt || telegramId == null || telegramId === '') return undefined

  return crypto.createHmac('sha256', salt).update(String(telegramId)).digest('hex').slice(0, 12)
}

module.exports = { logUid }
