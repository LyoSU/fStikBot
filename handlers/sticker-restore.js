const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')


module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  const result = await addSticker(ctx, sticker.file)

  let cbQueryText = ''

  if (result.ok) {
    cbQueryText = ctx.i18n.t('cmd.sticker.restored.ok')

    ctx.editMessageText(ctx.i18n.t('cmd.sticker.restored.ok'), {
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('cmd.sticker.btn.delete'), `delete_sticker:${result.ok.stickerInfo.file_id}`),
      ]),
    }).catch(() => {})
  }
  else if (result.error) {
    if (result.error.telegram) {
      cbQueryText = ctx.i18n.t('sticker.add.restored.telegram', {
        error: result.error.description,
      })
    }
  }

  ctx.answerCbQuery(cbQueryText, true)
}
