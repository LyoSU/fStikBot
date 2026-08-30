const { URL } = require('url')

// Bot launch + graceful shutdown.
// Webhook mode when BOT_DOMAIN is set, polling otherwise.
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

module.exports = async function launch (bot) {
  if (process.env.BOT_DOMAIN) {
    // Keep the original raw-token path — server nginx is configured to
    // proxy exactly this route to the bot port. Changing to sha256(token)
    // requires a coordinated nginx update; revisit as a separate change.
    const hookPath = `/fStikBot:${process.env.BOT_TOKEN}`
    let domain = process.env.BOT_DOMAIN
    if (domain.startsWith('https://') || domain.startsWith('http://')) {
      domain = new URL(domain).host
    }

    await bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath,
        port: process.env.WEBHOOK_PORT || 2500
      }
    })

    // telegraf 3's launch() calls setWebhook(url) with no extra — the top-level
    // `allowedUpdates` option it used to be passed here was simply ignored.
    // Re-issue the call ourselves with allowed_updates so the filter actually
    // reaches Telegram. setWebhook(url, extra) spreads extra into the payload.
    await bot.telegram.setWebhook(`https://${domain}${hookPath}`, {
      allowed_updates: ALLOWED_UPDATES
    })
    console.log('bot start webhook')
  } else {
    // telegraf 3 reads the polling options from config.polling — a top-level
    // `allowedUpdates` never made it to getUpdates.
    await bot.launch({ polling: { allowedUpdates: ALLOWED_UPDATES } })
    console.log('bot start polling')
  }
}

module.exports.ALLOWED_UPDATES = ALLOWED_UPDATES
