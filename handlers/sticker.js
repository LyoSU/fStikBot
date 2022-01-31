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
  let replyMarkup = {}

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  let stickerFile, stickerSet
  const stickerType = ctx.updateSubTypes[0]

  switch (stickerType) {
    case 'sticker':
      stickerFile = ctx.message.sticker
      break

    case 'document':
      if (['image/jpeg', 'image/png'].includes(ctx.message.document.mime_type)) {
        stickerFile = ctx.message.document
        if (ctx.message.caption) stickerFile.emoji = ctx.message.caption
      }
      break

    case 'animation':
      stickerFile = ctx.message.animation
      break

    case 'video':
      stickerFile = ctx.message.video
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
        if (addStickerResult.ok.webm) {
          return
        } else if (addStickerResult.ok.inline) {
          messageText = ctx.i18n.t('sticker.add.ok_inline', {
            title: escapeHTML(stickerSet.title)
          })

          replyMarkup = Markup.inlineKeyboard([
            Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
          ])
        } else {
          messageText = ctx.i18n.t('sticker.add.ok', {
            title: escapeHTML(addStickerResult.ok.title),
            link: addStickerResult.ok.link
          })

          replyMarkup = Markup.inlineKeyboard([
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), addStickerResult.ok.link)
          ])
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
      reply_to_message_id: ctx.message.message_id,
      reply_markup: replyMarkup
    })
  }
}
