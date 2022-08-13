const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')

module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet')

  if (sticker) {
    if (sticker.stickerSet.video === true) {
      sticker.file = sticker.info
      sticker.file.skip_reencode = true
    }
    const result = await addSticker(ctx, sticker.file)

    if (result.ok) {
      ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

      ctx.editMessageText(ctx.i18n.t('callback.sticker.restored'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${result.ok.stickerInfo.file_unique_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${result.ok.stickerInfo.file_unique_id}`)
        ])
      }).catch(() => {})
    } else if (result.error) {
      if (result.error.telegram.description.includes('STICKERSET_INVALID')) {
        ctx.answerCbQuery(ctx.i18n.t('callback.pack.error.copy'), true)
      } else if (result.error.telegram) {
        ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
          error: result.error.telegram.description
        }), true)
      }
    }
  } else {
    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }
}
