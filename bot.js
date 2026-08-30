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
const { runPreflight } = require('./bot/preflight')
const log = require('./utils/logger').scope('bot')

global.startDate = new Date()

const MONITOR_INTERVAL_MS = 25 * 1000

// NOTE: telegraf 3.40 has no `handlerTimeout` option at all (it was added in
// v4) — the one that used to be passed here was silently ignored. Polling
// throughput is handled by the POLLING_DETACH middleware in bot/middleware.js.
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false }
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

// Preflight runs the gauntlet before we accept any updates: validates
// env vars, waits for Mongo with a hard timeout, and pings Telegram
// getMe to verify the token. Any failure aborts with exit(1) so PM2
// surfaces the problem immediately instead of restarting a silent bot.
;(async () => {
  await runPreflight({ bot, dbConnection: db.connection })

  await launch(bot)

  // Don't block startup on the locale sync — it's eventually consistent.
  syncLocales(bot, i18n).catch((err) => log.error('[locale-sync] failed:', err.message))

  // Boot the broadcast worker — polls Broadcast collection for queued/stalled
  // campaigns and runs them in-process. Releases lock + drains on SIGTERM.
  require('./broadcast').startWorker()

  const monitorInterval = setInterval(() => updateMonitor(), MONITOR_INTERVAL_MS)
  if (monitorInterval.unref) monitorInterval.unref()
})().catch((err) => {
  log.error('Startup failed:', err?.stack || err)
  process.exit(1)
})

// Graceful shutdown — PM2 sends SIGTERM before killing.
//
// bot.stop() and the broadcast worker's drain are both async; the old version
// called process.exit(0) on the very next line, so in-flight updates were cut
// and the broadcast worker never got to release its lock or checkpoint. With
// cron_restart every 6h that happened four times a day.
//
// The worker registers its own SIGTERM/SIGINT listeners too; its stop() returns
// the same shared promise on every call, so awaiting it here really does wait
// for the drain no matter which listener ran first. This is the only path that
// calls process.exit.
//
// Two telegraf-3 specifics:
//   - bot.stop(cb) takes a CALLBACK, not a signal name — passing the string
//     made `cb()` throw inside telegraf and short-circuited the drain.
//   - In polling mode stop() only resolves once the in-flight getUpdates
//     long-poll returns (up to its 30s timeout), so it runs in PARALLEL with
//     the broadcast drain rather than in front of it — otherwise the worker
//     never got its turn inside the shutdown window.
// PM2 must give us that window: ecosystem.config.js sets kill_timeout above
// SHUTDOWN_TIMEOUT_MS (PM2's default is 1.6s, which would SIGKILL us first).
const SHUTDOWN_TIMEOUT_MS = 15_000
let shuttingDown = false

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return
  shuttingDown = true

  log.info(`${signal} received, shutting down gracefully…`)

  const drain = Promise.allSettled([
    bot.stop(),
    require('./broadcast').stopWorker()
  ]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') log.error('shutdown error:', r.reason?.stack || r.reason)
    }
  })

  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => {
      log.warn(`shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`)
      resolve()
    }, SHUTDOWN_TIMEOUT_MS)
    if (t.unref) t.unref()
  })

  await Promise.race([drain.catch((err) => log.error('shutdown error:', err?.stack || err)), timeout])

  process.exit(0)
}

process.on('SIGTERM', (signal) => { gracefulShutdown(signal || 'SIGTERM') })
process.on('SIGINT', (signal) => { gracefulShutdown(signal || 'SIGINT') })

// Postmortem logging for crashes. We don't suppress the default Node
// behavior (it exits the process), we just make sure the cause is in
// the log channel before PM2 restarts us. Without these, all we'd see
// in PM2 logs is "process exited" with no stack trace.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  // Re-throw so Node's default termination kicks in — promise state may
  // be inconsistent, restart is safer than continuing on corrupted state.
  // Use setImmediate so the error bubbles to uncaughtException with full
  // context, not swallowed by the rejection handler chain.
  setImmediate(() => { throw reason })
})

process.on('uncaughtException', (err, origin) => {
  log.error(`Uncaught exception (origin=${origin}):`, err?.stack || err)
  // Don't try to clean up — state is unknown. PM2 will restart us.
  process.exit(1)
})
