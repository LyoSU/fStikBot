// Which errors stay out of the admin log channel. Kept dependency-free so it
// can be unit-tested without a DB connection (handlers/catch.js pulls in
// ../utils, which opens mongoose).

// Errors that aren't actionable — we expect them in normal operation
// and logging each one just drowns out real signals.
function isExpectedNoise (error) {
  if (!error) return false

  // retry-api short-circuited a send to a blocked user — already handled
  if (error.__cachedBlock) return true

  // retry-api short-circuited a 429 cooldown — already logged once when
  // Telegram first told us retry_after > maxWait, every subsequent call
  // in the same window is the same story.
  if (error.__cachedRateLimit) return true

  const method = error?.on?.method
  const description = error?.description || ''

  // answerCallbackQuery expiry: callback_query_id has a ~5–10 min TTL
  // at Telegram. Handlers with handlerTimeout=60s rarely overrun this
  // directly, but a handler that sleeps on a 429 retry + does slow I/O
  // can. When it eventually answers, Telegram replies 400 "query is
  // too old". Not actionable — user already saw the button press.
  if (method === 'answerCallbackQuery' && /query is too old|query ID is invalid/i.test(description)) {
    return true
  }

  // We cannot post to that chat — the bot was demoted, kicked, blocked, the
  // topic is closed, the user is gone. Nothing in our code to fix; the admin
  // log channel used to get one of these per /ss in a locked-down group.
  if (UNREACHABLE_CHAT.test(description)) return true

  return false
}

const UNREACHABLE_CHAT = /not enough rights|CHAT_WRITE_FORBIDDEN|bot was kicked|bot is not a member|bot was blocked by the user|user is deactivated|TOPIC_CLOSED|have no rights to send a message/i

module.exports = { isExpectedNoise }
