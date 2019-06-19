
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')


const originalSticker = new Scene('originalSticker')


originalSticker.enter((ctx) => {
  ctx.replyWithHTML(ctx.i18n.t('scenes.original.enter'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel'),
      ],
    ]).resize(),
  })
})

originalSticker.on('sticker', async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileId: ctx.message.sticker.file_id,
    file: { $ne: null },
  })

  if (sticker) {
    ctx.replyWithDocument(sticker.file.file_id, {
      reply_to_message_id: ctx.message.message_id,
    })
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'))
  }
})

module.exports = [originalSticker]

