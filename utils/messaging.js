const fs = require('fs')
const path = require('path')
const Redis = require('ioredis')
const Telegram = require('telegraf/telegram')
const I18n = require('telegraf-i18n')
const replicators = require('telegraf/core/replicators')
const {
  db
} = require('../database')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Redis connection with retry strategy
const redis = new Redis({
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3
})

const telegram = new Telegram(process.env.MAIN_BOT_TOKEN)

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

// Cache config at startup instead of reading on every call
let cachedConfig = null
function getConfig() {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  }
  return cachedConfig
}

// Reload config every 5 minutes
setInterval(() => {
  try {
    cachedConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  } catch (e) {
    console.error('Failed to reload config:', e.message)
  }
}, 1000 * 60 * 5)

const messaging = async (messagingData) => {
  console.log(messagingData.id, `messaging ${messagingData.name} start`)

  const key = `messaging:${messagingData.id}`

  const usersCount = await redis.lrange(key + ':users', 0, -1).catch(console.error)

  if (!usersCount) return {}

  messagingData.status = 1
  await messagingData.save()

  let messagingCreator

  try {
    messagingCreator = await db.User.findById(messagingData.creator)
  } catch (err) {
    console.error('Failed to fetch messaging creator:', err.message)
  }

  const config = getConfig()

  const count = config.messaging.limit.max || 10

  const messagingSend = async () => {
    const state = parseInt(await redis.get(key + ':state')) || 0

    const users = await redis.lrange(key + ':users', state, state + count - 1).catch(() => {})

    if (users && users.length > 0) {
      for (const chatId of users) {
        let method = replicators.copyMethods[messagingData.message.type]
        let opts = Object.assign({}, messagingData.message.data, {
          chat_id: chatId,
          disable_web_page_preview: true,
          disable_notification: true
        })

        if (messagingData.message.type === 'forward') {
          method = 'forwardMessage'
          opts = {
            chat_id: chatId,
            from_chat_id: messagingData.message.data.chat_id,
            message_id: messagingData.message.data.message_id
          }
        }

        telegram.callApi(method, opts).then((result) => {
          redis.set(key + ':messages:' + chatId, result.message_id)
        }).catch((error) => {
          redis.incr(key + ':error')
          console.log(`messaging error ${messagingData.name}`, chatId, error.description)
          if (error?.parameters?.retry_after) {
            return new Error(error)
          } else if (['blocked by the user', 'user is deactivated', 'chat not found'].some(e => new RegExp(e).test(error.description))) {
            // Use updateOne to avoid race conditions and fire-and-forget issues
            db.User.updateOne({ telegram_id: chatId }, { blocked: true }).catch((err) => {
              console.error('Failed to mark user as blocked:', err.message)
            })
          } else {
            if (messagingCreator) {
              telegram.sendMessage(messagingCreator.telegram_id, `Error sending message "${messagingData.name}" to user ${chatId}: ${error.message}`, {
                parse_mode: 'HTML'
              })
            }

            messagingData.sendErrors.push({
              telegram_id: chatId,
              errorMessage: error.message
            })

            return new Error(error)
          }
        })
      }

      const errorCount = parseInt(await redis.get(key + ':error')) || 0
      messagingData.result.error = errorCount
      messagingData.result.state = state + users.length

      await redis.set(key + ':state', state + users.length)
    }

    if (state + users.length >= messagingData.result.total) {
      console.log(`messaging ${messagingData.name} end`)
      messagingData.status = 2
    }

    await messagingData.save()
    return messagingData
  }

  while (true) {
    const messagingData = await messagingSend()

    // Exit when: completed (status>=2), no users (total===0), or all processed (state>=total)
    if (messagingData.status >= 2 || messagingData.result.total === 0 || messagingData.result.state >= messagingData.result.total) {
      return messagingData
    }
    await delay(config.messaging.limit.duration || 1000)
  }
}

const messagingEdit = (messagingData) => new Promise(async (resolve) => {
  console.log(`messaging edit ${messagingData.name} start`)

  messagingData.editStatus = 2
  await messagingData.save()

  const config = getConfig()

  const key = `messaging:${messagingData.id}`
  const count = config.messaging.limit.max || 10

  const interval = setInterval(async () => {
    try {
      console.log('messaging edit')
      const state = parseInt(await redis.get(key + ':edit_state')) || 0

      if (state >= messagingData.result.total) {
        console.log(`messaging edit ${messagingData.name} end`)
        messagingData.editStatus = 0
        await messagingData.save()
        clearInterval(interval)
        resolve()
        return
      }

      const users = await redis.lrange(key, state, state + count).catch(() => {
        clearInterval(interval)
      })

      if (users && users.length > 0) {
        // Use for...of instead of forEach for proper async handling
        for (const chatId of users) {
          const messageId = await redis.get(key + ':messages:' + chatId)
          if (messagingData.message.type === 'text') {
            telegram.editMessageText(chatId, messageId, null, messagingData.message.data.text, {
              parse_mode: messagingData.message.data.parse_mode,
              disable_web_page_preview: messagingData.message.data.disable_web_page_preview,
              reply_markup: messagingData.message.data.reply_markup
            }).catch((error) => {
              console.error('Edit text error:', error.message)
            })
          } else {
            telegram.editMessageMedia(chatId, messageId, null, {
              type: messagingData.message.type,
              media: messagingData.message.data[messagingData.message.type],
              caption: messagingData.message.data.caption || '',
              parse_mode: messagingData.message.data.parse_mode
            }, {
              parse_mode: messagingData.message.data.parse_mode,
              disable_web_page_preview: messagingData.message.data.disable_web_page_preview,
              reply_markup: messagingData.message.data.reply_markup
            }).catch((error) => {
              console.error('Edit media error:', error.message)
            })
          }
        }
        await redis.set(key + ':edit_state', state + count)
      }
    } catch (error) {
      console.error('Messaging edit interval error:', error.message)
      clearInterval(interval)
      resolve()
    }
  }, config.messaging.limit.duration || 1000)
})

// Process messaging queues without cursor/listener leak
let isProcessingMessaging = false
let isProcessingEdit = false

async function processMessagingQueue() {
  if (isProcessingMessaging) return
  isProcessingMessaging = true

  try {
    const pendingMessages = await db.Messaging.find({
      status: { $lte: 0 },
      date: { $lte: new Date() }
    }).limit(10)

    for (const msg of pendingMessages) {
      await messaging(msg)
    }
  } catch (error) {
    console.error('Error processing messaging queue:', error.message)
  } finally {
    isProcessingMessaging = false
  }
}

async function processEditQueue() {
  if (isProcessingEdit) return
  isProcessingEdit = true

  try {
    const pendingEdits = await db.Messaging.find({
      editStatus: 1,
      date: { $lte: new Date() }
    }).limit(10)

    for (const msg of pendingEdits) {
      await messagingEdit(msg)
    }
  } catch (error) {
    console.error('Error processing edit queue:', error.message)
  } finally {
    isProcessingEdit = false
  }
}

// Track intervals for graceful shutdown
const messagingInterval = setInterval(processMessagingQueue, 5000)
const editInterval = setInterval(processEditQueue, 5000)

// Graceful shutdown handler
const shutdownMessaging = () => {
  console.log('Shutting down messaging queues...')
  clearInterval(messagingInterval)
  clearInterval(editInterval)
}

process.on('SIGTERM', shutdownMessaging)
process.on('SIGINT', shutdownMessaging)

const restartMessaging = async () => {
  const messagingData = await db.Messaging.findOne({
    status: 1
  })

  if (messagingData) await messaging(messagingData)

  const messagingDataEdit = await db.Messaging.findOne({
    editStatus: 2
  })

  if (messagingDataEdit) await messagingEdit(messagingDataEdit)
}

restartMessaging()
