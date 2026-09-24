// All `bot.use(...)` middleware + the privateMessage composer construction.
// Order matters — preserves the exact chain from the original bot.js.
const Composer = require('telegraf/composer')

const { perfStage, perfRecord, perfTick, ENABLED: PERF_TIMING_ENABLED } = require('../utils/perf-timing')
const { touchLastSeen } = require('../utils/last-seen')
const publicPackLimit = require('../utils/public-pack-limit')
const { wrapAnswerCbQuery } = require('../utils/callback-text')
const log = require('../utils/logger').scope('middleware')

const MAX_CHAIN_ACTIONS = 15

module.exports = (bot, {
  i18n,
  sessionMiddleware,
  updateUser,
  updateGroup,
  stats,
  retryMiddleware
}) => {
  // Polling throughput is decoupled from handler latency by telegraf's own
  // handlerTimeout (see bot.js) — no detach middleware needed here, and every
  // handler error reaches bot.catch the normal way.

  // answerCbQuery text is capped at 200 chars by Telegram and rendered as
  // plain text; our i18n strings are HTML written for replyWithHTML and a
  // dozen locales exceed the cap. Clamp centrally (utils/callback-text.js).
  bot.use((ctx, next) => {
    wrapAnswerCbQuery(ctx)
    return next()
  })

  // i18n
  bot.use(i18n)

  // Clears the blocked-chat cache for the current chat_id so a user who
  // unblocked us can receive replies immediately (the 429 retry itself lives
  // in the Telegram.prototype patch, utils/retry-api.js).
  bot.use(retryMiddleware())

  // Adding goes into the selected pack, so with the public pack selected every
  // add is a write to it. Deletes and restores check the pack they act on
  // (handlers/sticker-delete.js, sticker-restore.js); all share one budget.
  const limitPublicPack = (ctx, next) => {
    if (!publicPackLimit.isPublic(ctx?.session?.userInfo?.stickerSet)) return next()
    if (!ctx.from || publicPackLimit.take(ctx.from.id)) return next()
    return ctx.reply(ctx.i18n.t('ratelimit'))
  }

  // Response-time stats
  bot.use(stats)

  // Session (in-memory telegraf/session — see bot/session-store.js)
  bot.use(perfStage('session', sessionMiddleware))

  // Chain-actions logger: records the last N actions per session to help
  // reproduce error traces. Also prepares answerCbQuery/answerInlineQuery
  // state arrays so handlers can mutate them and the middleware finalizes.
  bot.use(async (ctx, next) => {
    if (ctx.session && !ctx.session.chainActions) ctx.session.chainActions = []
    let action

    if (ctx.message && ctx.message.text) action = ctx.message.text
    else if (ctx.callbackQuery) action = ctx.callbackQuery.data
    else if (ctx.updateType) action = `{${ctx.updateType}} `

    if (ctx.updateSubTypes) action += ` [${ctx.updateSubTypes.join(', ')}]`

    if (!action) action = 'undefined'

    if (ctx.session) {
      if (ctx.session.chainActions.length > MAX_CHAIN_ACTIONS) ctx.session.chainActions.shift()
      ctx.session.chainActions.push(action)
    }

    if (ctx.callbackQuery) ctx.state.answerCbQuery = []

    return next(ctx).then(() => {
      // Auto-answer the callback. Silently swallow failures: a long-running
      // handler can outlive Telegram's ~5-10 min callback_query_id TTL.
      // Propagating that would spam the global error handler with
      // "query is too old" noise.
      if (ctx.callbackQuery) {
        return ctx.answerCbQuery(...ctx.state.answerCbQuery).catch(() => {})
      }
    })
  })

  // Group chat commands upsert the group record
  bot.use(Composer.groupChat(Composer.command(updateGroup)))

  // User upsert — hydrates ctx.session.userInfo with a fresh Mongoose doc
  // from the DB. Runs BEFORE locale auto-switch and banned guard because
  // those read userInfo; without this ordering they'd see stale
  // Redis-hydrated plain objects (no save() method, stale flags).
  bot.use(perfStage('updateUser', async (ctx, next) => {
    await updateUser(ctx)
    return next()
  }))

  // Gentle Ukrainization — auto-switch ru → uk when Telegram reports uk.
  // Only for users who never picked a language themselves (localeChosen is
  // set by /lang): before that guard, choosing Russian via /lang was undone
  // on the very next update. Setting `locale` marks the doc dirty, so
  // persistUserIfDirty below saves it — no separate save() (which raced the
  // one below and threw ParallelSaveError).
  bot.use((ctx, next) => {
    const user = ctx?.session?.userInfo
    if (user?.locale === 'ru' && !user.localeChosen && ctx.from?.language_code === 'uk') {
      user.locale = 'uk'
      ctx.i18n.locale('uk')
    }
    return next()
  })

  // Banned user guard — runs after updateUser so the flag is fresh. Never
  // stops the main admin: it runs before the admin commands, so a banned main
  // admin could not unban themselves.
  bot.use((ctx, next) => {
    if (ctx?.session?.userInfo?.banned && ctx.from?.id !== ctx.config.mainAdminId) {
      // An inline_query has no chat to reply into: replyWithHTML threw on
      // every request from a banned user and filled the log channel. Telegram
      // wants answerInlineQuery here.
      if (ctx.inlineQuery) {
        return ctx.answerInlineQuery([], {
          is_personal: true,
          cache_time: 300
        }).catch(() => {})
      }
      return ctx.replyWithHTML(ctx.i18n.t('error.banned'))
    }
    return next()
  })

  // Persist userInfo after the handler runs. Split from the updateUser
  // middleware above so locale/banned middlewares can sit between
  // hydration and handler execution.
  //
  // Perf instrumentation is inlined (not via perfStage) because we want
  // to split the measurement: 'handler' captures the full downstream
  // next() — i.e. the rest of the middleware chain + handler body —
  // and 'userSave' captures just the post-next save() duration.
  // Persist the user doc only if a handler actually modified it. Unmodified
  // requests just throttle-bump updatedAt via a fire-and-forget updateOne
  // (see utils/last-seen.js). This turns ~every-update saves into ~once-
  // per-hour-per-user cheap updates + real saves only on real changes.
  const persistUserIfDirty = (ctx) => {
    const user = ctx.session?.userInfo
    if (!user || typeof user.save !== 'function') return null
    if (user.isModified && user.isModified()) {
      return user.save().catch(err => log.error('Failed to save user:', err.message))
    }
    // Not dirty — no save, just bump last-seen (throttled, async).
    touchLastSeen(ctx.db.User, user._id)
    return null
  }

  bot.use(async (ctx, next) => {
    if (!PERF_TIMING_ENABLED) {
      await next(ctx)
      const maybeSave = persistUserIfDirty(ctx)
      if (maybeSave) await maybeSave
      return
    }
    const handlerStart = Date.now()
    try {
      try {
        await next(ctx)
      } finally {
        // Wall-clock handler duration — recorded on success and on error
        // so perf samples reflect real load even when handlers throw.
        perfRecord('handler', Date.now() - handlerStart)
      }
      // Persist only on normal completion (preserves original behavior:
      // don't write userInfo after a handler error).
      const saveStart = Date.now()
      const maybeSave = persistUserIfDirty(ctx)
      try {
        if (maybeSave) await maybeSave
      } finally {
        perfRecord('userSave', Date.now() - saveStart)
      }
    } finally {
      // perfTick fires regardless of handler outcome so log cadence stays
      // stable under error load.
      perfTick()
    }
  })

  // my_chat_member updates are noisy — ignore them after user-update above
  // (which handles the blocked-flag flip).
  bot.use((ctx, next) => {
    if (ctx.update.my_chat_member) return false
    return next()
  })

  // privateMessage composer — only runs for 1:1 chats
  const privateMessage = new Composer()
  privateMessage.use((ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private') return next()
    return false
  })

  return { privateMessage, limitPublicPack }
}
