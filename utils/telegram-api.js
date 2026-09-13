// MTProto client (gram.js), used only for messages.GetStickerSet — the Bot API
// does not expose a set's owner, and the MTProto set id encodes it
// (utils/decode-sticker-set-id.js).
//
// Lazy: nothing connects until the first getClient() call, so requiring the
// utils barrel (scripts, tests) never opens a network session. Optional:
// without TELEGRAM_API_ID / TELEGRAM_API_HASH getClient() resolves to null and
// the owner lookup is simply skipped.
const { Api, TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const fs = require('fs')
const path = require('path')
const log = require('./logger').scope('mtproto')

const SESSION_FILE = path.join(__dirname, '../.mtproto-session')
// After a failed connect, don't retry on every request — gram.js already
// retries internally, and a dead MTProto should not slow every /about.
const RETRY_AFTER_FAILURE_MS = 60 * 1000

let client = null
let connecting = null
let lastFailureAt = 0

const isConfigured = () => !!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH)

async function connect () {
  let savedSession = ''
  if (fs.existsSync(SESSION_FILE)) {
    savedSession = fs.readFileSync(SESSION_FILE, 'utf8').trim()
  }

  const fresh = new TelegramClient(
    new StringSession(savedSession),
    parseInt(process.env.TELEGRAM_API_ID, 10),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  )
  fresh.setLogLevel('error')

  await fresh.start({ botAuthToken: process.env.BOT_TOKEN })

  // Persist the session so the next boot skips the auth round-trip. Best
  // effort: a read-only deployment (Docker, non-owner user) must not turn a
  // working connection into a failure.
  const sessionString = fresh.session.save()
  if (sessionString && sessionString !== savedSession) {
    try {
      fs.writeFileSync(SESSION_FILE, sessionString)
    } catch (err) {
      log.warn(`could not persist session to ${SESSION_FILE}: ${err.message}`)
    }
  }

  log.info('connected')
  return fresh
}

/**
 * The shared MTProto client, connecting on first use.
 *
 * @returns {Promise<TelegramClient|null>} null when MTProto is not configured
 *   or the connection is (currently) unavailable
 */
async function getClient () {
  if (!isConfigured()) return null
  if (client && client.connected) return client
  if (connecting) return connecting
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return null

  connecting = connect()
    .then((fresh) => {
      client = fresh
      return fresh
    })
    .catch((err) => {
      log.error('connection failed:', err.message)
      client = null
      lastFailureAt = Date.now()
      return null
    })
    .finally(() => {
      connecting = null
    })

  return connecting
}

module.exports = {
  Api,
  getClient
}
