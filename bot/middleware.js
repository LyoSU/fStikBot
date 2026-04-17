// All `bot.use(...)` middleware + the privateMessage composer construction.
// Order matters — preserves the exact chain from the original bot.js.
const Composer = require('telegraf/composer')
const rateLimit = require('telegraf-ratelimit')

const { perfStage, perfRecord, perfTick, ENABLED: PERF_TIMING_ENABLED } = require('../utils/perf-timing')
const { touchLastSeen } = require('../utils/last-seen')
const handleError = require('../handlers/catch')

const MAX_CHAIN_ACTIONS = 15

// Polling detach: enabled by default (set POLLING_DETACH=0 to disable).
// Default ON because we've verified the tradeoffs are covered:
//   - Errors routed through handleError (same pipeline as bot.catch)
//   - Heavy work already fire-and-forget at handler level (addSticker)
//   - Session save-wrap awaits user persist inline
const POLLING_DETACH = process.env.POLLING_DETACH !== '0'

module.exports = (bot, {
  i18n,
  sessionMiddleware,
  updateUser,
  updateGroup,
  stats,
  retryMiddleware
}) => {
  // Detach from Telegraf's batch-await loop.
  //
  // Telegraf 3.40's fetchUpdates does:
  //   handleUpdates(batch).then(() => fetchUpdates())   // next poll
  // which waits for Promise.all of all handleUpdate(u) in the batch to
  // resolve before issuing the next getUpdates. Returning a resolved
  // Promise from the FIRST middleware short-circuits that wait: the
  // batch Promise.all completes immediately, fetchUpdates re-polls, and
  // the downstream middleware chain still executes in the background.
  //
  // This preserves throughput under rare bursts where any middleware
  // gets slow. Trade-offs we consciously accept:
  //   - Telegraf's handlerTimeout (60s) cannot interrupt detached work.
  //     We don't rely on it — all slow paths are already fire-and-forget
  //     via Bull queues (convert/removebg) or the sticker-handler IIFE.
  //   - Two rapid updates from the same user run concurrently, so a
  //     session SET race is theoretically possible. Session is Redis-
  //     backed and small; dirty-check cuts writes; last writer wins for
  //     the rare race. Scene state advances one step at a time via user
  //     actions spaced >>100ms apart — not observed in practice.
  //   - Errors don't reach bot.catch. We route them through handleError
  //     manually so the log channel still gets git blame + stack +
  //     chainActions.
  // TEMP DEBUG: trace every incoming update through the middleware chain.
  // Remove once the silent-handler bug is localized.
  bot.use((ctx, next) => {
    const uid = ctx.from?.id
    const type = ctx.updateType
    const sub = ctx.updateSubTypes?.join(',')
    const text = ctx.message?.text || ctx.callbackQuery?.data || ctx.inlineQuery?.query
    console.log(`[DEBUG 0:entry] update=${ctx.update.update_id} type=${type}${sub ? '/' + sub : ''} from=${uid} text=${text?.slice(0, 40)}`)
    return next().then(
      () => console.log(`[DEBUG 0:done ] update=${ctx.update.update_id}`),
      (err) => console.log(`[DEBUG 0:throw] update=${ctx.update.update_id} err=${err?.message}`)
    )
  })

  if (POLLING_DETACH) {
    bot.use((ctx, next) => {
      next().catch((err) => handleError(err, ctx).catch((e) => {
        console.error('[polling-detach] handleError itself failed:', e)
      }))
      return Promise.resolve()
    })
  }

  // i18n
  bot.use(i18n)
  bot.use((ctx, next) => { console.log(`[DEBUG 1:i18n ] ${ctx.update.update_id}`); return next() })

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

  bot.use((ctx, next) => { console.log(`[DEBUG 2:stats] ${ctx.update.update_id}`); return next() })

  // Session (Redis-backed — see bot/session-store.js)
  bot.use(perfStage('session', sessionMiddleware))
  bot.use((ctx, next) => { console.log(`[DEBUG 3:sess ] ${ctx.update.update_id} hasSession=${!!ctx.session}`); return next() })

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

    if (ctx.inlineQuery) ctx.state.answerIQ = []
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
    console.log(`[DEBUG 4:uu-in ] ${ctx.update.update_id}`)
    await updateUser(ctx)
    console.log(`[DEBUG 4:uu-out] ${ctx.update.update_id}`)
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
  // Persist the user doc only if a handler actually modified it. Unmodified
  // requests just throttle-bump updatedAt via a fire-and-forget updateOne
  // (see utils/last-seen.js). This turns ~every-update saves into ~once-
  // per-hour-per-user cheap updates + real saves only on real changes.
  const persistUserIfDirty = (ctx) => {
    const user = ctx.session?.userInfo
    if (!user || typeof user.save !== 'function') return null
    if (user.isModified && user.isModified()) {
      return user.save().catch(err => console.error('Failed to save user:', err.message))
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

  bot.use((ctx, next) => { console.log(`[DEBUG 5:saveW] ${ctx.update.update_id}`); return next() })

  // my_chat_member updates are noisy — ignore them after user-update above
  // (which handles the blocked-flag flip).
  bot.use((ctx, next) => {
    if (ctx.update.my_chat_member) return false
    return next()
  })

  bot.use((ctx, next) => { console.log(`[DEBUG 6:mcm  ] ${ctx.update.update_id} → commands`); return next() })

  // privateMessage composer — only runs for 1:1 chats
  const privateMessage = new Composer()
  privateMessage.use((ctx, next) => {
    console.log(`[DEBUG 7:priv ] ${ctx.update.update_id} chatType=${ctx.chat?.type}`)
    if (ctx.chat && ctx.chat.type === 'private') return next()
    return false
  })

  return { privateMessage, limitPublicPack }
}
