const { Api, TelegramClient } = require('telegram')
const { StringSession, StoreSession } = require('telegram/sessions')

let telegramClinet = {}

;(async () => {
  telegramClinet = new TelegramClient(
    process.env.NODE_ENV === 'production' ? new StringSession('') : new StoreSession('./session'),
    parseInt(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  )
  await telegramClinet.start({
    botAuthToken: process.env.BOT_TOKEN
  })

  telegramClinet.setLogLevel('error') // only errors
})()

module.exports = {
  client: telegramClinet,
  Api
}
