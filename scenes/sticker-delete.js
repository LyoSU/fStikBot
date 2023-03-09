const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')

const deleteSticker = new Scene('deleteSticker')

deleteSticker.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.delete.enter'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

deleteSticker.on('sticker', async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.delete.confirm'), {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true,
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${ctx.message.sticker.file_unique_id}`)
      ]
    ])
  })
})

module.exports = deleteSticker
