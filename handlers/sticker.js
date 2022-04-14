const Markup = require('telegraf/markup')
const { addSticker, addStickerText } = require('../utils')

module.exports = async (ctx) => {
  await ctx.replyWithChatAction('upload_document')

  let messageText = ''
  let replyMarkup = {}

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  let stickerFile, stickerSet
  const stickerType = ctx.updateSubTypes[0]

  switch (stickerType) {
    case 'sticker':
      stickerFile = ctx.message.sticker
      break

    case 'document':
      if (
        ['image/jpeg', 'image/png'].includes(ctx.message.document.mime_type) ||
        ctx.message.document.mime_type.match('video')
      ) {
        stickerFile = ctx.message.document
        if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      }
      break

    case 'animation':
      // if caption tenor gif
      if (ctx.message.caption && ctx.message.caption.match('tenor.com')) {
        stickerFile = ctx.message.animation
        stickerFile.fileUrl = ctx.message.caption
      } else {
        stickerFile = ctx.message.animation
        if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      }
      break

    case 'video':
      stickerFile = ctx.message.video
      if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      stickerFile = ctx.message.photo.slice(-1)[0]
      if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      break

    default:
      console.log(ctx.updateSubTypes)
  }

  if (ctx.session.userInfo.stickerSet && ctx.session.userInfo.stickerSet.inline) {
    if (stickerType === 'photo') stickerFile = ctx.message[stickerType].pop()
    else stickerFile = ctx.message[stickerType]
    stickerFile.stickerType = stickerType
    if (ctx.message.caption) stickerFile.caption = ctx.message.caption
    stickerFile.file_unique_id = ctx.session.userInfo.stickerSet.id + '_' + stickerFile.file_unique_id
  }

  if (stickerFile) {
    if (stickerFile.is_animated && (!ctx.session.userInfo.stickerSet || !ctx.session.userInfo.stickerSet.inline)) {
      stickerSet = ctx.session.userInfo.animatedStickerSet
    } else if (stickerFile.is_video && (!ctx.session.userInfo.stickerSet || !ctx.session.userInfo.stickerSet.inline)) {
      stickerSet = ctx.session.userInfo.videoStickerSet
    } else {
      stickerSet = ctx.session.userInfo.stickerSet
    }

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
        reply_to_message_id: ctx.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.info.file_unique_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${sticker.info.file_unique_id}`)
        ])
      })
    } else {
      if (ctx.session.userInfo.autoEmoji || stickerFile.emoji || ctx.session.userInfo?.stickerSet?.inline) {
        const stickerInfo = await addSticker(ctx, stickerFile)

        const result = await addStickerText(ctx, stickerInfo)

        messageText = result.messageText
        replyMarkup = result.replyMarkup
      } else {
        ctx.session.previousSticker = {
          file: stickerFile
        }

        messageText = ctx.i18n.t('sticker.add.send_emoji')
      }
    }
  } else {
    messageText = ctx.i18n.t('sticker.add.error.file_type')
  }

  if (messageText) {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: replyMarkup
    })
  }
}
