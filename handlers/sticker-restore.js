const Markup = require('telegraf/markup')
const {
  addSticker
} = require('../utils')

module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet')

  if (sticker) {
    let newFileUniqueId

    if (sticker.stickerSet.inline === true) {
      sticker.deleted = false
      await sticker.save()

      await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'), true)

      newFileUniqueId = sticker.fileUniqueId
    } else {
      const stickerFile = await ctx.telegram.getFile(sticker.info.file_id)

      const fileExtension = stickerFile.file_path.split('.').pop()

      let stickerFormat

      if (fileExtension === 'tgs') {
        stickerFormat = 'animated'
        sticker.file.is_animated = true
      } else if ([ 'png', 'webp', 'jpg', 'jpeg' ].includes(fileExtension)) {
        stickerFormat = 'static'
      } else {
        stickerFormat = 'video'
        sticker.file.is_video = true
      }

      if (stickerFormat === 'video') {
        sticker.file = sticker.info
        sticker.file.skip_reencode = true
      }

      const result = await addSticker(ctx, sticker.file, sticker.stickerSet)

      if (result.error) {
        if (result.error.telegram.description.includes('STICKERSET_INVALID')) {
          return ctx.answerCbQuery(ctx.i18n.t('callback.pack.error.copy'), true)
        } else if (result.error.telegram) {
          return ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
            error: result.error.telegram.description
          }), true)
        }
      }

      newFileUniqueId = result.ok?.stickerInfo?.file_unique_id
    }

    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

    ctx.editMessageText(ctx.i18n.t('callback.sticker.restored'), {
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${newFileUniqueId}`, !!newFileUniqueId),
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${newFileUniqueId}`, !!newFileUniqueId)
      ])
    }).catch(() => {})
  } else {
    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }
}
