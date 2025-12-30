const { Api, TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const fs = require('fs')
const path = require('path')

const SESSION_FILE = path.join(__dirname, '../.mtproto-session')

let client = null
let isConnected = false
let connectionPromise = null

async function connect () {
  // Return existing connection or in-progress attempt
  if (isConnected && client) return client
  if (connectionPromise) return connectionPromise

  connectionPromise = (async () => {
    try {
      // Load saved session if exists
      let savedSession = ''
      if (fs.existsSync(SESSION_FILE)) {
        savedSession = fs.readFileSync(SESSION_FILE, 'utf8').trim()
      }

      const session = new StringSession(savedSession)

      client = new TelegramClient(
        session,
        parseInt(process.env.TELEGRAM_API_ID),
        process.env.TELEGRAM_API_HASH,
        { connectionRetries: 5 }
      )

      await client.start({
        botAuthToken: process.env.BOT_TOKEN
      })

      client.setLogLevel('error')

      // Save session for future restarts
      const sessionString = client.session.save()
      if (sessionString && sessionString !== savedSession) {
        fs.writeFileSync(SESSION_FILE, sessionString)
      }

      isConnected = true
      console.log('MTProto connected successfully')
      return client
    } catch (err) {
      console.error('MTProto connection failed:', err.message)
      client = null
      isConnected = false
      connectionPromise = null
      throw err
    }
  })()

  return connectionPromise
}

// Auto-connect on module load (don't block)
connect().catch(() => {})

module.exports = {
  get client () {
    return client
  },
  Api,
  connect,
  get isConnected () {
    return isConnected
  }
}
