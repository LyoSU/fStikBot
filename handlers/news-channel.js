const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const handleStart = require('./start')

const composer = new Composer()

composer.on('message', Composer.optional((ctx) => ctx?.chat?.type === 'private', async (ctx, next) => {
  // if ru locale
  if (ctx.session.userInfo.locale !== 'ru' || ctx.from.language_code !== 'ru') {
    return next()
  }

  if (!ctx?.config?.ruNewsChannel?.id) return next()

  // if not command
  if (ctx.message.text && ctx.message.text.indexOf('/') === 0) return next()

  // if createdAt < 14 days
  if (ctx.session.userInfo.createdAt > new Date().getTime() - 1000 * 60 * 60 * 24 * 14) {
    return next()
  }

  if (ctx.session.userInfo.newsSubscribedDate > new Date().getTime() - 1000 * 60 * 60 * 24 * 7) {
    return next()
  }

  // check subscribe to channel
  const getChatMember = await ctx.telegram.getChatMember(ctx?.config?.ruNewsChannel?.id, ctx.from.id).catch((error) => {
    console.error('getChatMember error', error)
    return {
      status: 'error',
      error
    }
  })

  if (['member', 'administrator', 'creator'].indexOf(getChatMember.status) === -1) {
    await ctx.replyWithHTML(ctx.i18n.t('news.join', {
      link: ctx?.config?.ruNewsChannel?.link
    }), {
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{
            text: ctx.i18n.t('news.join_btn'),
            url: ctx?.config?.ruNewsChannel?.link
          }],
          [{
            text: ctx.i18n.t('news.continue'),
            callback_data: 'start'
          }]
        ]
      }
    })

    // return next()
  } else {
    ctx.session.userInfo.newsSubscribedDate = new Date()
    return next()
  }
}))

composer.action('start', async (ctx, next) => {
  if (!ctx?.config?.ruNewsChannel?.id) return next()

  const getChatMember = await ctx.telegram.getChatMember(ctx?.config?.ruNewsChannel?.id, ctx.from.id).catch((error) => {
    console.error('getChatMember error', error)
    return {
      status: 'error',
      error
    }
  })

  if (['member', 'administrator', 'creator'].indexOf(getChatMember.status) === -1) {
    return ctx.answerCbQuery(ctx.i18n.t('news.not_joined'), true)
  } else {
    ctx.session.userInfo.newsSubscribedDate = new Date()
    await ctx.deleteMessage().catch(() => {})
    return handleStart(ctx)
  }
})

module.exports = composer
