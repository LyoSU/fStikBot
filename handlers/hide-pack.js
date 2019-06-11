const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  ctx.answerCbQuery()

  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  if (stickerSet.ownerId.toString() === user.id.toString()) {

    stickerSet.hide = stickerSet.hide !== true
    stickerSet.save()

    ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      Markup.callbackButton(ctx.i18n.t(
        stickerSet.hide === true ? 'cmd.packs.btn.restore' : 'cmd.packs.btn.hide'
      ), `hide_pack:${ctx.match[2]}`),
    ])).catch(() => {})
  }
}
