// Entrypoint — thin orchestrator. The old 681-line monolith was split into
// focused modules under bot/:
//   - bot/session-store.js  in-memory telegraf/session with bounded Map
//   - bot/middleware.js     all bot.use(...) middleware
//   - bot/commands.js       all commands / actions / hears registrations
//   - bot/locale-sync.js    mtime-cached locale push to Telegram
//   - bot/launch.js         webhook vs polling, allowedUpdates
const fs = require('fs')
const path = require('path')
const Telegraf = require('telegraf')
const I18n = require('telegraf-i18n')

const { db } = require('./database')
const handlers = require('./handlers')
const scenes = require('./scenes')
const {
  updateUser,
  updateGroup,
  stats,
  updateMonitor,
  retryMiddleware
} = require('./utils')

const { sessionMiddleware } = require('./bot/session-store')
const registerMiddleware = require('./bot/middleware')
const registerCommands = require('./bot/commands')
const launch = require('./bot/launch')
const syncLocales = require('./bot/locale-sync')

global.startDate = new Date()

// Was 1000ms — aborted any handler that touched Bull or a slow Telegram call.
// 60s is generous but bounded; PM2 will kill the process on true hangs.
const HANDLER_TIMEOUT_MS = 60_000
const MONITOR_INTERVAL_MS = 25 * 1000

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false },
  handlerTimeout: HANDLER_TIMEOUT_MS
})

bot.catch(handlers.handleError)

bot.context.config = require('./config.json')
bot.context.db = db

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

// Cached at startup — privacy policy is static HTML.
const privacyHtml = fs.readFileSync(path.resolve(__dirname, 'privacy.html'), 'utf-8')

const { privateMessage, limitPublicPack } = registerMiddleware(bot, {
  i18n,
  sessionMiddleware: sessionMiddleware(),
  updateUser,
  updateGroup,
  stats,
  retryMiddleware
})

registerCommands(bot, privateMessage, {
  handlers,
  limitPublicPack,
  privacyHtml,
  db,
  scenes
})

db.connection.once('open', async () => {
  console.log('Connected to MongoDB')

  await launch(bot)

  // Don't block startup on the locale sync — it's eventually consistent.
  syncLocales(bot, i18n).catch((err) => console.error('[locale-sync] failed:', err.message))

  // Side-effect import: starts messaging queue polling
  require('./utils/messaging')

  const monitorInterval = setInterval(() => updateMonitor(), MONITOR_INTERVAL_MS)
  if (monitorInterval.unref) monitorInterval.unref()
})

// Graceful shutdown — PM2 sends SIGTERM before killing
const gracefulShutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully...`)
  bot.stop(signal)
  process.exit(0)
}
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)
