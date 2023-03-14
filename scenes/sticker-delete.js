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

deleteSticker.on(['sticker', 'message'], async (ctx, next) => {
  let sticker

  if (ctx.message && ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    const customEmoji = ctx.message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return next()

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return next()

    sticker = emojiStickers[0]
  } else if (ctx.message && ctx.message.sticker) {
    sticker = ctx.message.sticker
  } else {
    return next()
  }

  if (!sticker) return next()

  await ctx.replyWithHTML(ctx.i18n.t('scenes.delete.confirm'), {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true,
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.file_unique_id}`)
      ]
    ])
  })
})

module.exports = deleteSticker
