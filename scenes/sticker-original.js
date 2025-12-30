const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const got = require('got')
const sharp = require('sharp')

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

    await ctx.replyWithSticker(originalFileId, {
      caption: sticker.emojis,
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    }).catch(async (stickerError) => {
      if (stickerError.description.match(/emoji/)) {
        const fileLink = await ctx.telegram.getFileLink(originalFileId)

        await ctx.replyWithDocument({
          url: fileLink,
          filename: `${originalFileUniqueId}.webp`
        }, {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        }).catch((error) => {
          ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
            error: error.description
          }), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
        })
      } else {
        ctx.replyWithPhoto(originalFileId, {
          caption: stickerInfo.emojis,
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        }).catch((photoError) => {
          ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
            error: photoError.description
          }), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
        })
      }
    })
  } else {
    const fileLink = await ctx.telegram.getFileLink(sticker.file_id)

    if (fileLink.endsWith('.webp')) {
      const buffer = await got(fileLink).buffer()
      const image = sharp(buffer, { failOnError: false }).png()

      await ctx.replyWithDocument({
        source: image,
        filename: `${sticker.file_unique_id}.png`
      }, {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: error.description
        }), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
      })
    } else if (fileLink.endsWith('.webm')) {
      await ctx.replyWithDocument({
        url: fileLink,
        filename: `${sticker.file_unique_id}.webm`
      }, {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: error.description
        }), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
      })
    } else if (fileLink.endsWith('.tgs')) {
      await ctx.replyWithDocument({
        url: fileLink,
        filename: `${sticker.file_unique_id}.tgs`
      }, {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: error.description
        }), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    }
  }
})

module.exports = [originalSticker]
