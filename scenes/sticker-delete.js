const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { deleteSticker } = require('../handlers/sticker-delete')

const deleteStickerScene = new Scene('deleteSticker')

deleteStickerScene.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.delete.enter'), {
  reply_markup: Markup.keyboard([
    [{ text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }]
  ]).resize()
}))

// Every sticker sent here is deleted right away; the reply carries "Restore"
// as the undo. It used to ask "Delete?" with a button for each one.
const resolveSticker = async (ctx) => {
  if (ctx.message.sticker) return ctx.message.sticker

  const entity = ctx.message.entities?.find((e) => e.type === 'custom_emoji')
  if (!entity) return null

  const stickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
    custom_emoji_ids: [entity.custom_emoji_id]
  }).catch(() => null)
  return stickers?.[0] || null
}

deleteStickerScene.on(['sticker', 'text'], async (ctx, next) => {
  const sticker = await resolveSticker(ctx)
  if (!sticker) return next()

  const result = await deleteSticker(ctx, sticker.file_unique_id, sticker)
  const reply = {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  }

  if (result.error) return ctx.replyWithHTML(result.error, reply)
  return ctx.replyWithHTML(result.ok.text, { ...result.ok.extra, ...reply })
})

module.exports = deleteStickerScene
