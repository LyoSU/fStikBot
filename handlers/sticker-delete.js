const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const setName = ctx.callbackQuery.message.reply_to_message.sticker.set_name
  const packBotUsername = setName.split('_').pop(-1)

  if (!ctx.session.user) ctx.session.user = await ctx.db.User.getData(ctx.from)
  const sticker = await ctx.db.Sticker.findOne({
    fileId: ctx.match[2],
  }).populate('stickerSet')

  let deleteSticker

  if (sticker && sticker.stickerSet.owner.toString() === ctx.session.user.id.toString()) {
    deleteSticker = sticker.info
  }
  else if (packBotUsername === ctx.options.username) {
    deleteSticker = ctx.callbackQuery.message.reply_to_message.sticker
  }

  if (deleteSticker) {
    const deleteStickerFromSet = await ctx.deleteStickerFromSet(deleteSticker.file_id).catch((error) => {
      ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
        error: error.description,
      }), true)
    })

    if (deleteStickerFromSet) {
      ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))

      ctx.editMessageText(ctx.i18n.t('callback.sticker.delete'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${deleteSticker.file_id}`),
        ]),
      }).catch(() => {})

      if (sticker) {
        sticker.deleted = true
        sticker.save()
      }
    }
  }
  else ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
}
