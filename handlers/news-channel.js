const Composer = require('telegraf/composer')

const DAY_MS = 24 * 60 * 60 * 1000
// Only users who have been around a while are asked, and at most once a week.
const MIN_ACCOUNT_AGE_MS = 14 * DAY_MS
const PROMPT_INTERVAL_MS = 7 * DAY_MS

const composer = new Composer()

const isSubscribed = async (ctx) => {
  const member = await ctx.telegram.getChatMember(ctx.config.ruNewsChannel.id, ctx.from.id).catch(() => null)
  return ['member', 'administrator', 'creator'].includes(member?.status)
}

const shouldAsk = (ctx) => {
  const user = ctx.session.userInfo
  if (!ctx.config?.ruNewsChannel?.id) return false
  if (user?.locale !== 'ru' || ctx.from.language_code !== 'ru') return false
  if (ctx.message.text?.startsWith('/')) return false
  if (user.createdAt > Date.now() - MIN_ACCOUNT_AGE_MS) return false
  return !(user.newsSubscribedDate > Date.now() - PROMPT_INTERVAL_MS)
}

// A subscription invite for the Russian-speaking audience. It never gets in
// the way: the message is handled as usual, and the invite is an extra reply
// at most once a week. It used to swallow every non-command message — photos
// included — until the user subscribed.
composer.on('message', Composer.privateChat(async (ctx, next) => {
  await next()

  if (!shouldAsk(ctx)) return

  // Marks this week as done whether or not they're subscribed.
  ctx.session.userInfo.newsSubscribedDate = new Date()
  if (await isSubscribed(ctx)) return

  await ctx.replyWithHTML(ctx.i18n.t('news.join', { link: ctx.config.ruNewsChannel.link }), {
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: ctx.i18n.t('news.join_btn'), url: ctx.config.ruNewsChannel.link }],
        [{ text: ctx.i18n.t('news.continue'), callback_data: 'news:close' }]
      ]
    }
  }).catch(() => {})
}))

composer.action(/^(news:close|start)$/, async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.deleteMessage().catch(() => {})
})

module.exports = composer
