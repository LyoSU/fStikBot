const Markup = require('telegraf/markup')
const {
  addSticker
} = require('../utils')

module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet', '_id name title inline animated video packType emojiSuffix frameType boost owner')

  if (!sticker) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }

  let newFileUniqueId

  if (sticker.stickerSet.inline === true) {
    // Inline stickers - just mark as not deleted
    sticker.deleted = false
    sticker.deletedAt = null
    await sticker.save()

    await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'), true)
    newFileUniqueId = sticker.fileUniqueId
  } else {
    // Regular stickers - need to re-add to Telegram
    const currentFileId = sticker.getFileId()
    const stickerFile = await ctx.telegram.getFile(currentFileId)
    const fileExtension = stickerFile.file_path.split('.').pop()

    // Build file object for addSticker
    const originalFileId = sticker.getOriginalFileId() || currentFileId
    const originalFileUniqueId = sticker.getOriginalFileUniqueId() || sticker.fileUniqueId

    const fileForRestore = {
      file_id: originalFileId,
      file_unique_id: originalFileUniqueId
    }

    // Determine format and set flags
    if (fileExtension === 'tgs') {
      fileForRestore.is_animated = true
    } else if (['png', 'webp', 'jpg', 'jpeg'].includes(fileExtension)) {
      // Static - no additional flags needed
    } else {
      // Video format
      fileForRestore.is_video = true
      // For video, use current file_id and skip re-encoding
      fileForRestore.file_id = currentFileId
      fileForRestore.skip_reencode = true
    }

    const result = await addSticker(ctx, fileForRestore, sticker.stickerSet)

    if (result.error) {
      if (result.error.type === 'duplicate') {
        return ctx.answerCbQuery(ctx.i18n.t('sticker.add.error.have_already'), true)
      } else if (result.error.telegram && result.error.telegram.description.includes('STICKERSET_INVALID')) {
        return ctx.answerCbQuery(ctx.i18n.t('callback.pack.error.copy'), true)
      } else if (result.error.telegram) {
        return ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
          error: result.error.telegram.description
        }), true)
      }
    }

    newFileUniqueId = result.ok && result.ok.stickerInfo && result.ok.stickerInfo.file_unique_id
  }

  ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

  ctx.editMessageText(ctx.i18n.t('callback.sticker.restored'), {
    reply_markup: Markup.inlineKeyboard([
      Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${newFileUniqueId}`, !!newFileUniqueId),
      Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${newFileUniqueId}`, !!newFileUniqueId)
    ])
  }).catch(() => {})
}
