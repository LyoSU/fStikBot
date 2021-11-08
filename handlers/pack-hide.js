const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  let answerCbQuer = ''

  if (stickerSet.owner.toString() === ctx.session.userInfo.id.toString()) {
    stickerSet.hide = stickerSet.hide !== true
    stickerSet.save()

    if (stickerSet.hide === true) {
      answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.hidden')

      const userSet = await ctx.db.StickerSet.findOne({
        owner: ctx.session.userInfo.id,
        create: true,
        hide: false
      })

      if (userSet) {
        if (userSet.animated) ctx.session.userInfo.animatedStickerSet = userSet.id
        else ctx.session.userInfo.stickerSet = userSet.id
      }
    } else {
      answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.restored')
    }
    await ctx.answerCbQuery(answerCbQuer)

    ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      Markup.callbackButton(ctx.i18n.t(stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'), `hide_pack:${ctx.match[2]}`)
    ])).catch(() => {})
  }
}
