const Markup = require('telegraf/markup')
const {
  addSticker
} = require('../utils')
const { humanizeTelegramError } = require('../utils/telegram-error')
const { safeEditMessage } = require('../utils/safe-edit')

module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet', '_id name title inline animated video packType emojiSuffix frameType boost owner')

  if (!sticker || !sticker.stickerSet) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }

  if (sticker.stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
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
    const stickerFile = await ctx.telegram.getFile(currentFileId).catch(() => null)

    if (!stickerFile) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

    // Legacy file_paths have no extension at all (e.g. `stickers/file_303092`).
    // split('.').pop() then returned the whole path, which fell into the video
    // branch below and made a static webp fail with STICKER_VIDEO_NOWEBM.
    // Only treat it as an extension when the last path segment really has one.
    const lastSegment = (stickerFile.file_path || '').split('/').pop()
    const fileExtension = lastSegment.includes('.')
      ? lastSegment.split('.').pop().toLowerCase()
      : null

    // Build file object for addSticker
    const originalFileId = sticker.getOriginalFileId() || currentFileId
    const originalFileUniqueId = sticker.getOriginalFileUniqueId() || sticker.fileUniqueId

    const fileForRestore = {
      file_id: originalFileId,
      file_unique_id: originalFileUniqueId
    }

    // No extension → fall back to what we know about the pack and the stored
    // media type instead of guessing "video".
    const storedType = typeof sticker.getStickerType === 'function' ? sticker.getStickerType() : null
    const looksVideo = fileExtension
      ? !['tgs', 'png', 'webp', 'jpg', 'jpeg'].includes(fileExtension)
      : (sticker.stickerSet.video === true || ['video', 'video_note', 'animation'].includes(storedType))
    const looksAnimated = fileExtension
      ? fileExtension === 'tgs'
      : sticker.stickerSet.animated === true

    // Determine format and set flags
    if (looksAnimated) {
      fileForRestore.is_animated = true
    } else if (looksVideo) {
      // Video format
      fileForRestore.is_video = true
      // For video, use current file_id and skip re-encoding
      fileForRestore.file_id = currentFileId
      fileForRestore.skip_reencode = true
    }
    // else: static — no additional flags needed

    const result = await addSticker(ctx, fileForRestore, sticker.stickerSet)

    if (result?.error) {
      const description = result.error.telegram?.description || result.error.telegram?.message || ''

      if (result.error.type === 'duplicate') {
        return ctx.answerCbQuery(ctx.i18n.t('sticker.add.error.have_already'), true)
      } else if (description.includes('STICKERSET_INVALID')) {
        return ctx.answerCbQuery(ctx.i18n.t('callback.pack.error.copy'), true)
      } else if (result.error.telegram) {
        return ctx.answerCbQuery(humanizeTelegramError(ctx, result.error.telegram), true)
      } else if (result.error.i18nKey) {
        return ctx.answerCbQuery(ctx.i18n.t(result.error.i18nKey), true)
      }

      // uploadSticker's { error: { message } } shape used to fall through every
      // branch above and end up reporting "successfully restored".
      return ctx.answerCbQuery(ctx.i18n.t('error.unknown'), true)
    }

    newFileUniqueId = result?.ok?.stickerInfo?.file_unique_id
  }

  if (!newFileUniqueId) {
    return ctx.answerCbQuery(ctx.i18n.t('error.unknown'), true)
  }

  await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

  await safeEditMessage(ctx, ctx.i18n.t('callback.sticker.restored'), {
    reply_markup: Markup.inlineKeyboard([
      // Third arg of callbackButton is `hide` — it was passed !!newFileUniqueId,
      // so the buttons disappeared exactly when they were valid and showed
      // `delete_sticker:undefined` when they weren't.
      { ...Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${newFileUniqueId}`), style: 'danger' },
      { ...Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${newFileUniqueId}`), style: 'primary' }
    ])
  })
}
