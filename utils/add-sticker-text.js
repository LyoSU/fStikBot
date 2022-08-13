const Markup = require('telegraf/markup')

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

module.exports = async (ctx, addStickerResult) => {
  let messageText = ''
  let replyMarkup = {}

  if (addStickerResult.ok) {
    ctx.session.previousSticker = {
      id: addStickerResult.ok.sticker.id
    }

    if (addStickerResult.ok.inline) {
      messageText = ctx.i18n.t('sticker.add.ok_inline', {
        title: escapeHTML(addStickerResult.ok.stickerSet.title)
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
  } else if (addStickerResult.error) {
    if (addStickerResult.error.telegram) {
      if (addStickerResult.error.telegram.description.includes('TOO_MUCH')) {
        messageText = ctx.i18n.t('sticker.add.error.stickers_too_much')
      } else if (addStickerResult.error.telegram.description.includes('STICKERSET_INVALID')) {
        messageText = ctx.i18n.t('sticker.add.error.stickerset_invalid')
      } else if (addStickerResult.error.telegram.description.includes('file is too big')) {
        messageText = ctx.i18n.t('sticker.add.error.too_big')
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

  return {
    messageText,
    replyMarkup
  }
}
