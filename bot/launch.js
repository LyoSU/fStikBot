// Bot launch + graceful shutdown.
// Webhook mode when BOT_DOMAIN is set, polling otherwise.
//
// allowedUpdates cuts channel_post, edited_channel_post, and poll updates
// at the Telegram side — the bot doesn't handle them, and previously there
// was a no-op bot.on([...]) catcher that still consumed network + CPU.
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
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
    await bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath,
        port: process.env.WEBHOOK_PORT || 2500
      },
      allowedUpdates: ALLOWED_UPDATES
    })
    console.log('bot start webhook')
  } else {
    await bot.launch({ allowedUpdates: ALLOWED_UPDATES })
    console.log('bot start polling')
  }
}

module.exports.ALLOWED_UPDATES = ALLOWED_UPDATES
