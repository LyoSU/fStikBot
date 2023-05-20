const Markup = require('telegraf/markup')
const {
  showGramAds,
  addSticker,
  addStickerText
} = require('../utils')

module.exports = async (ctx) => {
  ctx.replyWithChatAction('upload_document').catch(() => {})

  let messageText = ''
  let replyMarkup = {}

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const message = ctx.message || ctx.callbackQuery.message

  if (!ctx.session.userInfo.stickerSet) {
    return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_selected_pack'), {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true
    })
  }

  let stickerFile, stickerSet
  let stickerType = ctx.updateSubTypes[0]
  if (ctx.callbackQuery) stickerType = message.sticker ? 'sticker' : undefined

  switch (stickerType) {
    case 'sticker':
      stickerFile = message.sticker
      break

    case 'document':
      if (
        (message?.document?.mime_type.match('image') ||
        message?.document?.mime_type?.match('video'))
        && !message.document.mime_type.match(/heic|heif/)
      ) {
        stickerFile = message.document
        if (message.caption) stickerFile.emoji = message.caption
      }
      break

    case 'animation':
      // if caption tenor gif
      if (message.caption && message.caption.match('tenor.com')) {
        stickerFile = message.animation
        stickerFile.fileUrl = message.caption
      } else {
        stickerFile = message.animation
        if (message.caption) stickerFile.emoji = message.caption
      }
      break

    case 'video':
      stickerFile = message.video
      if (message.caption) stickerFile.emoji = message.caption
      break

    case 'video_note':
        stickerFile = message.video_note
        stickerFile.video_note = true
    break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      stickerFile = message.photo.slice(-1)[0]
      if (message.caption) stickerFile.emoji = message.caption
      break

    default:
      break
  }

  if (stickerType === 'text') {
    const customEmoji = message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return

    stickerFile = emojiStickers[0]
  }

  if (ctx.session.userInfo.stickerSet.inline) {
    if (stickerType === 'photo') stickerFile = message[stickerType].pop()
    else stickerFile = message[stickerType]

    stickerFile.stickerType = stickerType

    if (message.caption) stickerFile.caption = message.caption
    stickerFile.file_unique_id = ctx.session.userInfo.stickerSet.id + '_' + stickerFile.file_unique_id
  }

  if (ctx.callbackQuery) {
    stickerFile = ctx.callbackQuery.message.sticker
  }

  if (stickerFile) {
    stickerSet = ctx.session.userInfo.stickerSet
    if (message.caption?.includes('roundit')) stickerFile.video_note = true
    if (message.caption?.includes('cropit')) stickerFile.forceCrop = true
    if (message.photo && message.caption?.includes('!')) stickerFile.removeBg = true

    const originalSticker = await ctx.db.Sticker.findOne({
      stickerSet,
      fileUniqueId: stickerFile.file_unique_id,
      deleted: false
    })

    let sticker

    if (originalSticker) {
      sticker = originalSticker
    } else {
      sticker = await ctx.db.Sticker.findOne({
        stickerSet,
        'file.file_unique_id': stickerFile.file_unique_id,
        deleted: false
      })
    }

    if (sticker) {
      ctx.session.previousSticker = {
        id: sticker.id
      }

      await ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.info.file_unique_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${sticker.info.file_unique_id}`)
        ])
      })
    } else {
      if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo.premium && !stickerSet?.boost) {
        showGramAds(ctx.chat.id)
      }

      ctx.session.previousSticker = null

      const stickerInfo = await addSticker(ctx, stickerFile)

      if (stickerInfo.wait) {
        return
      }

      const result = addStickerText(stickerInfo, ctx.i18n.locale())

      messageText = result.messageText
      replyMarkup = result.replyMarkup

      // if (typeof stickerSet?.publishDate === 'undefined' && !stickerSet?.animated && !stickerSet?.inline) {
      //   const countStickers = await ctx.db.Sticker.count({
      //     stickerSet,
      //     deleted: false
      //   })

      //   if ([15, 50, 80, 120].includes(countStickers)) {
      //     setTimeout(async () => {
      //       await ctx.replyWithHTML(ctx.i18n.t('sticker.add.catalog_offer', {
      //         title: escapeHTML(stickerSet.title),
      //         link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
      //       }), {
      //         reply_markup: Markup.inlineKeyboard([
      //           Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_add'), `catalog:publish:${stickerSet.id}`)
      //         ])
      //       })
      //     }, 1000 * 2)
      //   }
      // }
    }
  } else {
    messageText = ctx.i18n.t('sticker.add.error.file_type.unknown')
  }

  if (messageText) {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
      reply_markup: replyMarkup
    })
  }
}
