const { URL } = require('url')
const log = require('../utils/logger').scope('launch')

// Bot launch: webhook mode when BOT_DOMAIN is set, polling otherwise.
//
// allowedUpdates cuts channel_post, edited_channel_post, and poll updates
// at the Telegram side — the bot doesn't handle them, and previously there
// was a no-op bot.on([...]) catcher that still consumed network + CPU.
//
// edited_message is deliberately NOT in the list: there's no handler for it,
// telegraf reports empty updateSubTypes, and the update still burned a full
// updateUser + session pass.
const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'inline_query',
  'pre_checkout_query',
  'my_chat_member'
]

module.exports = async function launch (bot, { isShuttingDown = () => false } = {}) {
  if (process.env.BOT_DOMAIN) {
    // Keep the original raw-token path — server nginx is configured to
    // proxy exactly this route to the bot port. Changing to sha256(token)
    // requires a coordinated nginx update; revisit as a separate change.
    const hookPath = `/fStikBot:${process.env.BOT_TOKEN}`
    let domain = process.env.BOT_DOMAIN
    if (domain.startsWith('https://') || domain.startsWith('http://')) {
      domain = new URL(domain).host
    }

    // No `domain` in the launch config: telegraf 3 then only starts the HTTP
    // server and skips its own setWebhook(url) — which takes no extra and
    // would have dropped allowed_updates. We register the hook ourselves.
    await bot.launch({
      webhook: {
        hookPath,
        port: process.env.WEBHOOK_PORT || 2500
      }
    })

    await bot.telegram.setWebhook(`https://${domain}${hookPath}`, {
      allowed_updates: ALLOWED_UPDATES
    })
    log.info('bot started (webhook)')
    return
  }

  // telegraf 3 reads the polling options from config.polling — a top-level
  // `allowedUpdates` never made it to getUpdates.
  //
  // bot.launch() never rejects and a 401/409 on getUpdates silently stops
  // polling while the process stays alive, so PM2 would report a healthy bot
  // that receives nothing. stopCallback is the only hook telegraf gives us to
  // notice that; exit so PM2 restarts us (or surfaces a bad token).
  await bot.launch({
    polling: {
      allowedUpdates: ALLOWED_UPDATES,
      stopCallback: () => {
        if (isShuttingDown()) return
        log.error('polling stopped unexpectedly — exiting so PM2 restarts the bot')
        process.exit(1)
      }
    }
  })
  log.info('bot started (polling)')
}

module.exports.ALLOWED_UPDATES = ALLOWED_UPDATES
