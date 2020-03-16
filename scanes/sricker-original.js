const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')

const originalSticker = new Scene('originalSticker')

originalSticker.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.original.enter'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

originalSticker.on('sticker', async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.message.sticker.file_unique_id,
    file: { $ne: null }
  })

  if (sticker) {
    await ctx.replyWithDocument(sticker.file.file_id, {
      caption: sticker.emojis,
      reply_to_message_id: ctx.message.message_id
    }).catch((documentError) => {
      if (documentError.description === 'Bad Request: type of file mismatch') {
        ctx.replyWithPhoto(sticker.file.file_id, {
          caption: sticker.emojis,
          reply_to_message_id: ctx.message.message_id
        }).catch((pohotoError) => {
          ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
            error: pohotoError.description
          }), {
            reply_to_message_id: ctx.message.message_id
          })
        })
      } else {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: documentError.description
        }), {
          reply_to_message_id: ctx.message.message_id
        })
      }
    })
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
})

module.exports = [originalSticker]
