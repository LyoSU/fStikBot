/* eslint-disable camelcase */
const config = require('../config.json')
const Telegram = require('telegraf/telegram')

const telegram = new Telegram(process.env.BOT_TOKEN)

const updateMonitor = async () => {
  // check the number of updates to hang unmodified. we received a notification that a lot of updates were not completed. For example, for the duration of 1 update more than 10 updates were not processed
  const webhookInfo = await telegram.getWebhookInfo().catch(console.error)

  if (!webhookInfo) {
    return
  }

  const { pending_update_count } = webhookInfo

  if (pending_update_count > 100) {
    console.error(`The number of pending updates is ${pending_update_count}. The bot is hanging.`)

    // send a message to the developer
    await telegram.sendMessage(config.logChatId, `❌ The number of pending updates is ${pending_update_count}. The bot is hanging ❌`).catch(console.error).then(() => {
      process.exit(1) // exit the process
    })
  } else if (pending_update_count > 40 && pending_update_count % 10 === 0) {
    console.warn(`The number of pending updates is ${pending_update_count}. The bot may be hanging.`)

    // send a message to the developer
    await telegram.sendMessage(config.logChatId, `⚠️ The number of pending updates is ${pending_update_count}. The bot may be hanging ⚠️`).catch(console.error)
  }
}

module.exports = updateMonitor
