const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const {
  db
} = require('./database')
const {
  handleStart,
  handleDonate,
  handleSticker,
  handleDeleteSticker,
  handleRestoreSticker,
  handlePacks,
  handleHidePack,
  handleRestorePack,
  handleCopyPack,
  handleLanguage,
  handleEmoji
  // handleMessaging
} = require('./handlers')
const scenes = require('./scenes')

global.startDate = new Date()

// init bot
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    webhookReply: false
  }
})

bot.on(['channel_post', 'edited_channel_post'], () => {})

// I18n settings
const { match } = I18n
const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
  defaultLanguageOnMissing: true
})

// I18n middleware
bot.use(i18n)

// rate limit
const limitConfig = {
  window: 300,
  limit: 1,
  onLimitExceeded: (ctx) => ctx.reply(ctx.i18n.t('ratelimit'))
}

bot.use(rateLimit(limitConfig))

// error handling
bot.catch((error, ctx) => {
  console.error(`error for ${ctx.updateType}`, error)
})

// bot config
bot.context.config = require('./config.json')

// db connect
bot.context.db = db

// use session
bot.use(session({ ttl: 60 * 5 }))

// response time logger
bot.use(async (ctx, next) => {
  const ms = new Date()

  if (ctx.from) {
    if (!ctx.session.user) {
      ctx.session.user = await db.User.updateData(ctx.from)
    } else {
      db.User.updateData(ctx.from).then((user) => {
        ctx.session.user = user
      })
    }
  }
  if (ctx.session.user && ctx.session.user.locale) ctx.i18n.locale(ctx.session.user.locale)
  if (ctx.callbackQuery) ctx.state.answerCbQuery = []
  return next(ctx).then(() => {
    if (ctx.callbackQuery) ctx.answerCbQuery(...ctx.state.answerCbQuery)
    console.log('Response time %sms', new Date() - ms)
  })
})

// scene
bot.use(scenes)

// main commands
bot.hears(['/packs', match('cmd.start.btn.packs')], handlePacks)
bot.hears(['/animpacks', match('cmd.start.btn.animpacks')], handlePacks)
bot.hears(['/new', match('cmd.start.btn.new')], (ctx) => ctx.scene.enter('сhoosePackType'))
bot.hears(['/donate', '/start donate', match('cmd.start.btn.donate')], handleDonate)
bot.hears(/addstickers\/(.*)/, handleCopyPack)
bot.command('emoji', handleEmoji)
bot.command('copy', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.copy')))
bot.command('restore', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.restore')))
bot.command('original', (ctx) => ctx.scene.enter('originalSticker'))
bot.command('lang', handleLanguage)

// bot.command('mess', handleMessaging)

// sticker detect
bot.on(['sticker', 'document', 'photo'], handleSticker)

// callback
bot.action(/(set_pack):(.*)/, handlePacks)
bot.action(/(hide_pack):(.*)/, handleHidePack)
bot.action(/(delete_sticker):(.*)/, handleDeleteSticker)
bot.action(/(restore_sticker):(.*)/, handleRestoreSticker)
bot.action(/set_language:(.*)/, handleLanguage)

// forward from sticker bot
bot.on('text', (ctx, next) => {
  if (ctx.message.forward_from && ctx.message.forward_from.id === 429000) handleRestorePack(ctx)
  else return next()
})

// donate
bot.action(/(donate):(.*)/, handleDonate)
bot.on('pre_checkout_query', ({ answerPreCheckoutQuery }) => answerPreCheckoutQuery(true))
bot.on('successful_payment', handleDonate)

// any message
bot.on('message', handleStart)

// start bot
db.connection.once('open', async () => {
  console.log('Connected to MongoDB')
  if (process.env.BOT_DOMAIN) {
    bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath: `/fStikBot:${process.env.BOT_TOKEN}`,
        port: process.env.WEBHOOK_PORT || 2500
      }
    }).then(() => {
      console.log('bot start webhook')
    })
  } else {
    bot.launch().then(() => {
      console.log('bot start polling')
    })
  }
})
