require('dotenv').config({ path: './.env' })

// Validate the two env vars everything else needs BEFORE loading the bot:
// database/connection.js and utils/telegram.js both throw at require time
// when they are missing, which used to abort with a Mongoose stack trace
// instead of a message naming the variable.
const { requireBotToken, requireMongoUri } = require('./bot/preflight')

for (const check of [requireBotToken(), requireMongoUri()]) {
  if (!check.ok) {
    console.error(`✗ ${check.name} — ${check.detail}`)
    process.exit(1)
  }
}

require('./bot')
