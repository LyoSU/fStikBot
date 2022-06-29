const { addSticker, addStickerText } = require('../utils')

module.exports = async (ctx, next) => {
  if (!ctx.session.previousSticker) return next()
  ctx.replyWithChatAction('upload_document').catch(() => {})

  let sticker
  let stickerIndex = -1
  const emoji = ctx.match.input

  if (ctx.session.previousSticker.id) {
    sticker = await ctx.db.Sticker.findById(ctx.session.previousSticker.id).populate('stickerSet')

    const stickerSet = await ctx.tg.getStickerSet(sticker.stickerSet.name)

    stickerIndex = stickerSet.stickers.findIndex((v) => {
      return v.file_unique_id === sticker.fileUniqueId
    })
  } else {
    sticker = ctx.session.previousSticker
  }

  sticker.file.emoji = emoji

  const stickerInfo = await addSticker(ctx, sticker.file, sticker?.stickerSet)

  if (stickerInfo.ok) {
    ctx.session.previousSticker = {
      id: stickerInfo.ok.sticker.id
    }
  }

  if (sticker.id) {
    if (stickerInfo.ok) {
      if (stickerIndex >= 0) await ctx.tg.setStickerPositionInSet(stickerInfo.ok.stickerInfo.file_id, stickerIndex).catch(() => {})
      await ctx.deleteStickerFromSet(sticker.info.file_id).catch(() => {})

      sticker.deleted = true
      await sticker.save()

      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
        reply_to_message_id: ctx.message.message_id
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.error'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  } else {
    const { messageText, replyMarkup } = await addStickerText(ctx, stickerInfo)

    if (messageText) {
      await ctx.replyWithHTML(messageText, {
        reply_to_message_id: ctx.message.message_id,
        reply_markup: replyMarkup
      })
    }
  }
}
