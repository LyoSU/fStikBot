const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  let packBotUsername
  let deleteSticker

  if (ctx.callbackQuery.message.reply_to_message && ctx.callbackQuery.message.reply_to_message.sticker) {
    const setName = ctx.callbackQuery.message.reply_to_message.sticker.set_name

    if (setName) {
      packBotUsername = setName.split('_').pop(-1)
    } else {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }
  }

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet')

  if (sticker && sticker.stickerSet.owner.toString() === ctx.session.userInfo.id.toString()) {
    deleteSticker = sticker.info.file_id
  } else if (packBotUsername && packBotUsername === ctx.options.username) {
    deleteSticker = ctx.callbackQuery.message.reply_to_message.sticker.file_id
  }

  if (deleteSticker) {
    let deleteStickerFromSet
    if (ctx.session.userInfo.stickerSet.passcode === 'public') {
      const stickerSet = await ctx.tg.getStickerSet(sticker.stickerSet.name)

      if (stickerSet.stickers[0].file_unique_id === sticker.fileUniqueId) {
        return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
      }
    }

    if (ctx.session.userInfo.stickerSet && ctx.session.userInfo.stickerSet.inline) {
      deleteStickerFromSet = true
    } else {
      deleteStickerFromSet = await ctx.deleteStickerFromSet(deleteSticker).catch((error) => {
        ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
          error: error.description
        }), true)
      })
    }

    if (deleteStickerFromSet) {
      ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))

      ctx.editMessageText(ctx.i18n.t('callback.sticker.delete'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${sticker.info.file_unique_id}`)
        ])
      }).catch(() => {})

      if (sticker) {
        sticker.deleted = true
        sticker.save()
      }
    }
  } else ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
}
