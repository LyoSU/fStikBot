const { Api, TelegramClient } = require('telegram')
const { StoreSession } = require('telegram/sessions')

let telegramClinet = {}

;(async () => {
  telegramClinet = new TelegramClient(
    new StoreSession('./session'),
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
