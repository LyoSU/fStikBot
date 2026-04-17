const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const escapeHTML = require('../utils/html-escape')
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

    // Primary goal of /original: show which pack the sticker was copied
    // FROM. The copy record has the source's file_unique_id; if fStikBot
    // has ever indexed the source pack, the source sticker's record will
    // resolve to a StickerSet with name+title.
    if (originalFileUniqueId) {
      const sourceSticker = await ctx.db.Sticker.findOne({
        fileUniqueId: originalFileUniqueId,
        stickerSet: { $ne: stickerInfo.stickerSet }
      }).populate('stickerSet')

      const sourcePack = sourceSticker && sourceSticker.stickerSet
      if (sourcePack && !sourcePack.deleted && sourcePack.name && sourcePack.title) {
        const linkPrefix = sourcePack.packType === 'custom_emoji'
          ? 'https://t.me/addemoji/'
          : 'https://t.me/addstickers/'
        await ctx.replyWithHTML(
          ctx.i18n.t('scenes.original.source_found', {
            link: `${linkPrefix}${sourcePack.name}`,
            title: escapeHTML(sourcePack.title)
          }),
          replyExtra
        )
        return
      }
    }

    // Source pack isn't in our DB — give the user the original file instead.
    // Optimistic: try echoing as a sticker (cheap, preserves animation). On
    // any failure — expired file_id, DOCUMENT_INVALID, emoji/regular mismatch
    // — fall through to downloading and re-uploading as a document. NEVER
    // sendPhoto/sendVideo: Telegram rejects sticker file_ids there.
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

  // No copy record — this is either an untracked sticker or the user sent
  // the original itself. Give them the file back.
  await sendStickerAsDocument(ctx, sticker.file_id, sticker.file_unique_id, replyExtra)
})

module.exports = [originalSticker]
