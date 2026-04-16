// All `bot.use(...)` middleware + the privateMessage composer construction.
// Order matters — preserves the exact chain from the original bot.js.
const Composer = require('telegraf/composer')
const rateLimit = require('telegraf-ratelimit')

const { perfStage, perfRecord, perfTick, ENABLED: PERF_TIMING_ENABLED } = require('../utils/perf-timing')

const MAX_CHAIN_ACTIONS = 15

module.exports = (bot, {
  i18n,
  sessionMiddleware,
  updateUser,
  updateGroup,
  stats,
  retryMiddleware
}) => {
  // i18n
  bot.use(i18n)

  // Retry 429s at the ctx level (prototype-level patch already handles the
  // underlying Telegram.callApi; this just exposes ctx.withRetry helper)
  // AND clears the blocked-chat cache for the current chat_id so a user
  // who unblocked us can receive replies immediately.
  bot.use(retryMiddleware())

  // Rate-limit writes to public packs (1 sticker per minute) to prevent
  // vandalism on shared "public" sets.
  const limitPublicPack = Composer.optional(
    (ctx) => ctx?.session?.userInfo?.stickerSet?.passcode === 'public',
    rateLimit({
      window: 1000 * 60,
      limit: 1,
      onLimitExceeded: (ctx) => ctx.reply(ctx.i18n.t('ratelimit'))
    })
  )

  // Response-time stats
  bot.use(stats)

  // Session (Redis-backed — see bot/session-store.js)
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

    if (ctx.inlineQuery) {
      await updateUser(ctx)
      ctx.state.answerIQ = []
    }
    if (ctx.callbackQuery) ctx.state.answerCbQuery = []

    return next(ctx).then(() => {
      // Auto-answer the callback. Silently swallow failures: with
      // handlerTimeout=60s, a long-running handler can outlive Telegram's
      // ~5-10 min callback_query_id TTL. Propagating that would spam the
      // global error handler with "query is too old" noise.
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

  // Лагідна українізація — auto-switch ru → uk when Telegram reports uk.
  // Now runs after updateUser so userInfo is a live Mongoose doc and
  // its .save() actually fires.
  bot.use((ctx, next) => {
    if (
      ctx?.session?.userInfo?.locale === 'ru' &&
      ctx.from && ctx.from.language_code === 'uk'
    ) {
      ctx.session.userInfo.locale = 'uk'
      if (typeof ctx.session.userInfo.save === 'function') {
        ctx.session.userInfo.save().catch(err => console.error('Failed to save user locale:', err.message))
      }
      ctx.i18n.locale('uk')
    }
    return next()
  })

  // Banned user guard — runs after updateUser so the flag is fresh.
  bot.use((ctx, next) => {
    if (ctx?.session?.userInfo?.banned) {
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
  bot.use(async (ctx, next) => {
    if (!PERF_TIMING_ENABLED) {
      await next(ctx)
      if (ctx.session?.userInfo && typeof ctx.session.userInfo.save === 'function') {
        await ctx.session.userInfo.save().catch(err => console.error('Failed to save user:', err.message))
      }
      return
    }
    const handlerStart = Date.now()
    try {
      await next(ctx)
    } finally {
      perfRecord('handler', Date.now() - handlerStart)
    }
    if (ctx.session?.userInfo && typeof ctx.session.userInfo.save === 'function') {
      const saveStart = Date.now()
      try {
        await ctx.session.userInfo.save().catch(err => console.error('Failed to save user:', err.message))
      } finally {
        perfRecord('userSave', Date.now() - saveStart)
      }
    }
    perfTick()
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
