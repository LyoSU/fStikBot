const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  if (sticker.stickerSet.owner.toString() === user.id.toString()) {
    const deleteStickerFromSet = await ctx.deleteStickerFromSet(sticker.info.file_id).catch((error) => {
      ctx.answerCbQuery(ctx.i18n.t('cmd.sticker.delete.error.telegram', {
        error: error.description,
      }), true)
    })

    if (deleteStickerFromSet) {
      ctx.answerCbQuery(ctx.i18n.t('cmd.sticker.delete.ok'))

      ctx.editMessageText(ctx.i18n.t('cmd.sticker.delete.ok'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('cmd.sticker.btn.restore'), `restore_sticker:${sticker.info.file_id}`),
        ]),
      }).catch(() => {})

      sticker.deleted = true
      sticker.save()
    }
  }
}
