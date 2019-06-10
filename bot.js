const path = require('path')
const Telegraf = require('telegraf')
const I18n = require('telegraf-i18n')
const {
  db,
} = require('./database')
const {
  handleStart,
  handleSticker,
  handleMessage,
} = require('./handlers')


global.startDate = new Date()

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.context.db = db

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
})

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use((ctx, next) => {
  ctx.ms = new Date()
  next()
})
bot.use(i18n.middleware())
bot.use(async (ctx, next) => {
  await db.User.updateData(ctx.from)
  await next(ctx)
  const ms = new Date() - ctx.ms

  console.log('Response time %sms', ms)
})

bot.start(handleStart)
bot.on(['sticker', 'document', 'photo'], handleSticker)
bot.on('message', handleMessage)

bot.catch((error) => {
  console.log('Oops', error)
})

bot.launch()

console.log('bot start')
