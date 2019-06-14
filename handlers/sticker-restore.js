const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')


module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  const result = await addSticker(ctx, sticker.file)

  if (result.ok) {
    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

    ctx.editMessageText(ctx.i18n.t('callback.sticker.restored'), {
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${result.ok.stickerInfo.file_id}`),
      ]),
    }).catch(() => {})
  }
  else if (result.error) {
    if (result.error.telegram) {
      ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
        error: result.error.telegram.description,
      }), true)
    }
  }
}
