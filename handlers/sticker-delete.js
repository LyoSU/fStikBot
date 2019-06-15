const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  if (!ctx.db.user) ctx.db.user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  if (sticker && sticker.stickerSet.owner.toString() === ctx.db.user.id.toString()) {
    const deleteStickerFromSet = await ctx.deleteStickerFromSet(sticker.info.file_id).catch((error) => {
      ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
        error: error.description,
      }), true)
    })

    if (deleteStickerFromSet) {
      ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))

      ctx.editMessageText(ctx.i18n.t('callback.sticker.delete'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${sticker.info.file_id}`),
        ]),
      }).catch(() => {})

      sticker.deleted = true
      sticker.save()
    }
  }
  else {
    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }
}
