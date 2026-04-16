// All `bot.use(...)` middleware + the privateMessage composer construction.
// Order matters — preserves the exact chain from the original bot.js.
const Composer = require('telegraf/composer')
const rateLimit = require('telegraf-ratelimit')

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
  // underlying Telegram.callApi; this just exposes ctx.withRetry helper).
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
  bot.use(sessionMiddleware)

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
      if (ctx.callbackQuery) return ctx.answerCbQuery(...ctx.state.answerCbQuery)
    })
  })

  // Group chat commands upsert the group record
  bot.use(Composer.groupChat(Composer.command(updateGroup)))

  // Лагідна українізація — auto-switch ru → uk when Telegram reports uk
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

  // Banned user guard
  bot.use((ctx, next) => {
    if (ctx?.session?.userInfo?.banned) {
      return ctx.replyWithHTML(ctx.i18n.t('error.banned'))
    }
    return next()
  })

  // User upsert + persist after handler runs
  bot.use(async (ctx, next) => {
    await updateUser(ctx)
    await next(ctx)
    if (ctx.session?.userInfo && typeof ctx.session.userInfo.save === 'function') {
      await ctx.session.userInfo.save().catch(err => console.error('Failed to save user:', err.message))
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
