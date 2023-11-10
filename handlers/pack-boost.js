const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const rateLimit = require('telegraf-ratelimit')
const { escapeHTML } = require('../utils')

const composer = new Composer()

composer.action(/boost:(yes|no):(.*)/, rateLimit({
  window: 3000,
  limit: 1,
  onLimitExceeded: async (ctx) => {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.too_fast'), true)
  }
}), async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  if (!stickerSet) return ctx.answerCbQuery(ctx.i18n.t('scenes.error.notFound'))

  if (ctx.match[1] === 'yes') {
    if (ctx.session.userInfo.balance < 1) return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.not_enough_credits'), true)

    if (stickerSet.boost) return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)

    stickerSet.boost = true
    await stickerSet.save()

    ctx.session.userInfo.balance -= 1
    await ctx.session.userInfo.save()

    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.success', {
      title: stickerSet.title
    }), true)
  }

  if (ctx.match[1] === 'no') {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.canceled'), true)
  }

  await ctx.deleteMessage().catch(() => {})
})

composer.action(/boost:(.*)/, async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[1])

  if (!stickerSet) return ctx.answerCbQuery(ctx.i18n.t('scenes.error.notFound'))

  const resultText = ctx.i18n.t('scenes.boost.sure', {
    title: escapeHTML(stickerSet.title),
    link: `https://t.me/addstickers/${stickerSet.name}`,
    balance: ctx.session.userInfo.balance
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.yes'), `boost:yes:${stickerSet._id}`),
      Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.no'), `boost:no:${stickerSet._id}`)
    ]
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(() => {})
  } else {
    await ctx.replyWithHTML(resultText, {
      reply_markup: replyMarkup
    })
  }
})

module.exports = composer
