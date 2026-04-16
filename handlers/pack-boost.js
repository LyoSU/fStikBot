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

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  if (ctx.match[1] === 'yes') {
    if (ctx.session.userInfo.balance < 1) return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.not_enough_credits'), true)

    if (stickerSet.boost) return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)

    // Use atomic operations to prevent race conditions
    const updateResult = await ctx.db.StickerSet.updateOne(
      { _id: stickerSet._id, boost: { $ne: true } },
      { $set: { boost: true } }
    )

    if (updateResult.modifiedCount === 0) {
      return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)
    }

    await ctx.db.User.updateOne(
      { _id: ctx.session.userInfo._id },
      { $inc: { balance: -1 } }
    )
    ctx.session.userInfo.balance -= 1

    const linkPrefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix
    const titleSuffix = ` :: @${ctx.options.username}`

    await ctx.answerCbQuery()
    await ctx.editMessageText(ctx.i18n.t('scenes.boost.success', {
      title: escapeHTML(stickerSet.title),
      link: `${linkPrefix}${stickerSet.name}`,
      titleSuffix: escapeHTML(titleSuffix)
    }), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }).catch(err => console.error('Failed to edit boost message:', err.message))
    return
  }

  if (ctx.match[1] === 'no') {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.canceled'), true)
    await ctx.deleteMessage().catch(err => console.error('Failed to delete message:', err.message))
  }
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
      { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.yes'), `boost:yes:${stickerSet._id}`), style: 'success' },
      { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.no'), `boost:no:${stickerSet._id}`), style: 'danger' }
    ]
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(err => console.error('Failed to edit boost message:', err.message))
  } else {
    await ctx.replyWithHTML(resultText, {
      reply_markup: replyMarkup
    })
  }
})

module.exports = composer
