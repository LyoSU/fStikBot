// utils/telegram.js
// Ensure retry-api prototype patch is applied before any Telegram instance is created.
require('./retry-api')

const Telegram = require('telegraf/telegram')

const instances = new Map()

/**
 * Get (or lazily create) a shared Telegram client for a given bot token.
 * Using the same token always returns the same instance — reuses the HTTP agent
 * and prevents listener/memory accumulation across the codebase.
 */
function getTelegram (token = process.env.BOT_TOKEN) {
  if (!token) throw new Error('BOT_TOKEN is required')
  let client = instances.get(token)
  if (!client) {
    client = new Telegram(token)
    instances.set(token, client)
  }
  return client
}

// Convenience default for the primary bot token
module.exports = getTelegram()
module.exports.get = getTelegram
module.exports.Telegram = Telegram
