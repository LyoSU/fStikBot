const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const sendStickerAsDocument = require('../utils/send-sticker-as-document')

const originalSticker = new Scene('originalSticker')

originalSticker.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.original.enter'), {
    reply_markup: Markup.keyboard([
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})

originalSticker.on(['sticker', 'text'], async (ctx, next) => {
  let sticker

  if (ctx.message.text) {
    if (!ctx.message.entities) return next()

    const customEmoji = ctx.message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return next()

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return next()

    sticker = emojiStickers[0]
  } else {
    sticker = ctx.message.sticker
  }

  const replyExtra = {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  }

  // Query supports both new (original) and legacy (file) schema
  const stickerInfo = await ctx.db.Sticker.findOne({
    fileUniqueId: sticker.file_unique_id,
    $or: [
      { 'original.fileId': { $ne: null } },
      { 'file.file_id': { $ne: null } }
    ]
  })

  if (stickerInfo && stickerInfo.hasOriginal()) {
    const originalFileId = stickerInfo.getOriginalFileId()
    const originalFileUniqueId = stickerInfo.getOriginalFileUniqueId()

    // Optimistic path: try echoing the original as a sticker (cheap, preserves
    // animation/emoji). Falls through to the document fallback on any failure
    // — e.g. expired file_id, custom_emoji vs. regular mismatch, deleted pack.
    try {
      await ctx.replyWithSticker(originalFileId, {
        ...replyExtra,
        caption: stickerInfo.emojis
      })
      return
    } catch (_) { /* fall through to document fallback */ }

    await sendStickerAsDocument(ctx, originalFileId, originalFileUniqueId, replyExtra)
    return
  }

  const result = await sendStickerAsDocument(ctx, sticker.file_id, sticker.file_unique_id, replyExtra)
  if (result === 'unsupported') {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'), replyExtra)
  }
})

module.exports = [originalSticker]
