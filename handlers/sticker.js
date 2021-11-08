const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')

const escapeHTML = (str) => str.replace(
  /[&<>'"]/g,
  (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

module.exports = async (ctx) => {
  await ctx.replyWithChatAction('upload_document')

  let messageText = ''

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  let stickerFile, stickerSet
  const stickerType = ctx.updateSubTypes[0]

  switch (stickerType) {
    case 'sticker':
      stickerFile = ctx.message.sticker
      break

    case 'document':
      if (['image/jpeg', 'image/png'].indexOf(ctx.message.document.mime_type) >= 0) {
        stickerFile = ctx.message.document
        if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      }
      break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      stickerFile = ctx.message.photo.slice(-1)[0]
      if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      break

    default:
      console.log(ctx.updateSubTypes)
  }

  if (ctx.session.userInfo.stickerSet.private) {
    stickerFile = ctx.message[stickerType]
    stickerFile.stickerType = stickerType
  }

  if (stickerFile) {
    if (stickerFile.is_animated) {
      stickerSet = ctx.session.userInfo.animatedStickerSet
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
      await ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
        reply_to_message_id: ctx.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.info.file_unique_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${sticker.info.file_unique_id}`)
        ])
      })
    } else {
      const addStickerResult = await addSticker(ctx, stickerFile)

      if (addStickerResult.ok) {
        if (addStickerResult.ok.private) {
          messageText = ctx.i18n.t('sticker.add.ok_private', {
            botUsername: ctx.options.username
          })
        } else {
          messageText = ctx.i18n.t('sticker.add.ok', {
            title: escapeHTML(addStickerResult.ok.title),
            link: addStickerResult.ok.link
          })
        }

        // const stickersCount = await ctx.db.Sticker.count({ stickerSet, deleted: false })

        // if ([7, 10, 15, 20, 30, 50, 70].includes(stickersCount)) {
        //   await ctx.replyWithHTML(ctx.i18n.t('sticker.add.offer_publish'))
        // }
      } else if (addStickerResult.error) {
        if (addStickerResult.error.telegram) {
          if (addStickerResult.error.telegram.description.includes('TOO_MUCH')) {
            messageText = ctx.i18n.t('sticker.add.error.stickers_too_much')
          } else if (addStickerResult.error.telegram.description.includes('STICKERSET_INVALID')) {
            messageText = ctx.i18n.t('sticker.add.error.stickerset_invalid')
          } else {
            messageText = ctx.i18n.t('error.telegram', {
              error: addStickerResult.error.telegram.description
            })
          }
        } else if (addStickerResult.error === 'ITS_ANIMATED') messageText = ctx.i18n.t('sticker.add.error.file_type')
        else {
          messageText = ctx.i18n.t('error.telegram', {
            error: addStickerResult.error
          })
        }
      }
    }
  } else {
    messageText = ctx.i18n.t('sticker.add.error.file_type')
  }

  if (messageText) {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
