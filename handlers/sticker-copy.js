const { addSticker } = require('../utils')


module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  const result = await addSticker(ctx, sticker.file)

  let cbQueryText = ''

  if (result.ok) {
    cbQueryText = ctx.i18n.t('callback.sticker.answerCbQuery.copy')
  }
  else if (result.error) {
    if (result.error.telegram) {
      cbQueryText = ctx.i18n.t('error.answerCbQuery.telegram', {
        error: result.error.telegram.description,
      })
    }
  }

  ctx.answerCbQuery(cbQueryText, true)
}
