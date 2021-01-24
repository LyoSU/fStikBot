const fs = require('fs')
const path = require('path')
const Redis = require('ioredis')
const Telegram = require('telegraf/telegram')
const I18n = require('telegraf-i18n')
const replicators = require('telegraf/core/replicators')
const {
  db
} = require('../database')

const redis = new Redis()

const telegram = new Telegram(process.env.BOT_TOKEN)

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

const messaging = (messagingData) => new Promise((resolve) => {
  console.log(`messaging ${messagingData.name} start`)

  messagingData.status = 1
  messagingData.save()

  let messagingCreator

  db.User.findById(messagingData.creator).then((data) => {
    messagingCreator = data
  })

  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))

  const key = `messaging:${messagingData.id}`
  const count = config.messaging.limit.max || 10

  const interval = setInterval(async () => {
    console.log('messaging')
    const state = parseInt(await redis.get(key + ':state')) || 0

    if (state >= messagingData.result.total) {
      console.log(`messaging ${messagingData.name} end`)
      messagingData.status = 2
      messagingData.save()
      clearInterval(interval)
      resolve()
    }
    const users = await redis.lrange(key, state, state + count).catch(() => {
      clearInterval(interval)
    })

    if (users && users.length > 0) {
      users.forEach(chatId => {
        const method = replicators.copyMethods[messagingData.message.type]
        const opts = Object.assign(messagingData.message.data, {
          chat_id: chatId,
          disable_notification: true
        })

        telegram.callApi(method, opts).then((result) => {
          redis.set(key + ':messages:' + chatId, result.message_id)
        }).catch((error) => {
          redis.incr(key + ':error')
          console.log(`messaging error ${messagingData.name}`, error.description)
          if (error.description.includes('blocked by the user') || error.description.includes('user is deactivated')) {
            db.User.findOne({ telegram_id: chatId }).then((blockedUser) => {
              blockedUser.blocked = true
              blockedUser.save()
            })
          } else {
            if (messagingCreator) {
              telegram.sendMessage(messagingCreator.telegram_id, i18n.t('uk', 'admin.messaging.send_error', {
                name: messagingData.name,
                telegramId: chatId,
                errorMessage: error.message
              }), {
                parse_mode: 'HTML'
              })
            }

            messagingData.sendErrors.push({
              telegram_id: chatId,
              errorMessage: error.message
            })
          }
        })
      })

      const errorCount = parseInt(await redis.get(key + ':error')) || 0
      messagingData.result.error = errorCount
      messagingData.result.state = state
      messagingData.save()

      await redis.set(key + ':state', state + count + 1)
    }
  }, config.messaging.limit.duration || 1000)
})

const messagingEdit = (messagingData) => new Promise((resolve) => {
  console.log(`messaging edit ${messagingData.name} start`)

  messagingData.editStatus = 2
  messagingData.save()

  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))

  const key = `messaging:${messagingData.id}`
  const count = config.messaging.limit.max || 10

  const interval = setInterval(async () => {
    console.log('messaging edit')
    const state = parseInt(await redis.get(key + ':edit_state')) || 0

    if (state >= messagingData.result.total) {
      console.log(`messaging edit ${messagingData.name} end`)
      messagingData.editStatus = 0
      messagingData.save()
      clearInterval(interval)
      resolve()
    }

    const users = await redis.lrange(key, state, state + count).catch(() => {
      clearInterval(interval)
    })

    if (users && users.length > 0) {
      users.forEach(async (chatId) => {
        const messageId = await redis.get(key + ':messages:' + chatId)
        if (messagingData.message.type === 'text') {
          telegram.editMessageText(chatId, messageId, null, messagingData.message.data.text, {
            parse_mode: messagingData.message.data.parse_mode,
            disable_web_page_preview: messagingData.message.data.disable_web_page_preview,
            reply_markup: messagingData.message.data.reply_markup
          }).catch((error) => {
            console.log(error)
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
            console.log(error)
          })
        }
      })
      await redis.set(key + ':edit_state', state + count)
    }
  }, config.messaging.limit.duration || 1000)
})

setTimeout(async function f () {
  const cursorMessaging = await db.Messaging.find({
    status: { $lte: 0 },
    date: {
      $lte: new Date()
    }
  }).cursor()

  cursorMessaging.on('data', messaging)

  const cursorMessagingEdit = await db.Messaging.find({
    editStatus: 1,
    date: {
      $lte: new Date()
    }
  }).cursor()

  cursorMessagingEdit.on('data', messagingEdit)

  setTimeout(f, 5000)
}, 5000)

const restartMessaging = async () => {
  const cursorMessaging = await db.Messaging.find({
    status: 1
  }).cursor()

  cursorMessaging.on('data', messaging)

  const cursorMessagingEdit = await db.Messaging.find({
    editStatus: 2
  }).cursor()

  cursorMessagingEdit.on('data', messagingEdit)
}

restartMessaging()
