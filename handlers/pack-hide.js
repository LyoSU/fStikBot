const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  if (!stickerSet) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
  }

  let answerCbQuer = ''

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  stickerSet.hide = stickerSet.hide !== true
  stickerSet.save()

  if (stickerSet.hide === true) {
    answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.hidden')

    const userSet = await ctx.db.StickerSet.findOne({
      owner: ctx.session.userInfo.id,
      create: true,
      hide: false
    }).sort({ updatedAt: -1 })

    if (userSet) {
      ctx.session.userInfo.stickerSet = userSet
      await ctx.session.userInfo.save()
    }
  } else {
    answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.restored')
  }
  await ctx.answerCbQuery(answerCbQuer)

  const inlineKeyboard = []

  if (stickerSet.hide === true) {
    inlineKeyboard.push([
      Markup.callbackButton(ctx.i18n.t('callback.pack.btn.delete'), `delete_pack:${ctx.match[2]}`)
    ])
  }

  inlineKeyboard.push([
    Markup.callbackButton(ctx.i18n.t(stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'), `hide_pack:${ctx.match[2]}`)
  ])

  ctx.editMessageReplyMarkup(Markup.inlineKeyboard(inlineKeyboard)).catch(() => {})
}
