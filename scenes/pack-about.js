const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { telegramApi } = require('../utils')

function decodeStickerSetId (u64) {
  let u32 = u64 >> 32n
  let u32l = u64 & 0xffffffffn

  if ((u64 >> 24n & 0xffn) === 0xffn) {
    return parseInt((u64 >> 32n) + 0x100000000n)
  }
  return {
    ownerId: parseInt(u32),
    id: parseInt(u32l)
  }
}

function encodeStickerSetId (ownerId, id) {
  let u64 = BigInt(ownerId) << 32n
  u64 += BigInt(id)
  return u64
}

const packAbout = new Scene('packAbout')

packAbout.enter(async (ctx) => {
  await ctx.replyWithHTML('Send me a sticker or a custom emoji', {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

packAbout.on(['sticker', 'text'], async (ctx, next) => {
  if (!ctx.message) return

  let sticker

  if (ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    const customEmoji = ctx.message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return

    sticker = emojiStickers[0]
  } else if (ctx.message.sticker) {
    sticker = ctx.message.sticker
  } else {
    return next()
  }

  if (!sticker) return

  const stickerSetInfo = await telegramApi.client.invoke(new telegramApi.Api.messages.GetStickerSet({
    stickerset: new telegramApi.Api.InputStickerSetShortName({
      shortName: sticker.set_name
    }),
    hash: 0
  }))

  if (!stickerSetInfo) return next()

  const { ownerId } = decodeStickerSetId(stickerSetInfo.set.id)

  return ctx.replyWithHTML(`owner_id: <code>${ownerId}</code> (<a href="tg://user?id=${onwerId}">mention</a>)\noffical: <code>${stickerSetInfo.set.official}</code>`)
})

module.exports = packAbout
