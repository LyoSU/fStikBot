const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  let answerCbQuer = ''

  if (stickerSet.owner.toString() === user.id.toString()) {
    stickerSet.hide = stickerSet.hide !== true
    stickerSet.save()

    if (stickerSet.hide === true) {
      answerCbQuer = ctx.i18n.t('cmd.pack.answerCbQuer.hidden')

      const userSet = await ctx.db.StickerSet.findOne({
        owner: user.id,
        create: true,
        hide: false,
      })

      user.stickerSet = userSet.id
      user.save()
    }
    else {
      answerCbQuer = ctx.i18n.t('cmd.pack.answerCbQuer.restored')
    }
    ctx.answerCbQuery(answerCbQuer)

    ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      Markup.callbackButton(ctx.i18n.t(stickerSet.hide === true ? 'cmd.pack.btn.restore' : 'cmd.pack.btn.hide'), `hide_pack:${ctx.match[2]}`),
    ])).catch(() => {})
  }
}
