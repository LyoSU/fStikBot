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
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2]).catch(() => null)

  if (!stickerSet) return ctx.answerCbQuery(ctx.i18n.t('scenes.error.notFound'))

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  if (ctx.match[1] === 'yes') {
    if (stickerSet.boost) return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)

    // Charge first, atomically and only when the balance covers it — the
    // session balance can be stale, and two taps in a row used to take it
    // below zero. Mongoose 5 reports `nModified` (there is no
    // `modifiedCount`, so the old "already boosted" guard never fired).
    const charged = await ctx.db.User.updateOne(
      { _id: ctx.session.userInfo._id, balance: { $gte: 1 } },
      { $inc: { balance: -1 } }
    )
    if (!charged.nModified) {
      return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.not_enough_credits'), true)
    }

    const boosted = await ctx.db.StickerSet.updateOne(
      { _id: stickerSet._id, boost: { $ne: true } },
      { $set: { boost: true } }
    )
    if (!boosted.nModified) {
      // Someone boosted it in the meantime — give the credit back.
      await ctx.db.User.updateOne({ _id: ctx.session.userInfo._id }, { $inc: { balance: 1 } })
      return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)
    }

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
    }).catch(() => {}) // benign: message-not-modified / best-effort UI refresh
    return
  }

  if (ctx.match[1] === 'no') {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.canceled'), true)
    await ctx.deleteMessage().catch(err => console.error('Failed to delete message:', err.message))
  }
})

composer.action(/boost:(.*)/, async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[1]).catch(() => null)

  if (!stickerSet) return ctx.answerCbQuery(ctx.i18n.t('scenes.error.notFound'))

  // The confirmation text embeds the pack title and link, so a forged
  // boost:<id> was a read primitive for any pack, hidden ones included.
  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

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
    }).catch(() => {}) // benign: message-not-modified / best-effort UI refresh
  } else {
    await ctx.replyWithHTML(resultText, {
      reply_markup: replyMarkup
    })
  }
})

module.exports = composer
