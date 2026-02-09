const path = require('path')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const escapeHTML = require('./html-escape')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

module.exports = (addStickerResult, lang) => {
  let messageText = ''
  let replyMarkup = {}

  if (addStickerResult.ok) {
    if (addStickerResult.ok.inline) {
      messageText = i18n.t(lang, 'sticker.add.ok_inline', {
        title: escapeHTML(addStickerResult.ok.stickerSet.title)
      })

      replyMarkup = Markup.inlineKeyboard([
        Markup.switchToChatButton(i18n.t(lang, 'callback.pack.btn.use_pack'), '')
      ])
    } else {
      messageText = i18n.t(lang, 'sticker.add.ok', {
        title: escapeHTML(addStickerResult.ok.title),
        link: addStickerResult.ok.link
      })

      replyMarkup = Markup.inlineKeyboard([
        Markup.urlButton(i18n.t(lang, 'callback.pack.btn.use_pack'), addStickerResult.ok.link)
      ])
    }
  } else if (addStickerResult.error) {
    if (addStickerResult.error.type === 'duplicate') {
      messageText = i18n.t(lang, 'sticker.add.error.have_already')

      if (addStickerResult.error.sticker) {
        replyMarkup = Markup.inlineKeyboard([
          { ...Markup.callbackButton(i18n.t(lang, 'callback.sticker.btn.delete'), `delete_sticker:${addStickerResult.error.sticker.fileUniqueId}`), style: 'danger' },
          { ...Markup.callbackButton(i18n.t(lang, 'callback.sticker.btn.copy'), `restore_sticker:${addStickerResult.error.sticker.fileUniqueId}`), style: 'primary' }
        ])
      }
    } else if (addStickerResult.error.telegram) {
      const errDescription = addStickerResult.error.telegram.description || addStickerResult.error.telegram.message || ''
      if (!errDescription) {
        throw new Error(JSON.stringify(addStickerResult.error))
      } else if (errDescription.includes('TOO_MUCH')) {
        messageText = i18n.t(lang, 'sticker.add.error.stickers_too_much')
      } else if (errDescription.includes('STICKERSET_INVALID')) {
        messageText = i18n.t(lang, 'sticker.add.error.stickerset_invalid')
      } else if (errDescription.includes('file is too big') || errDescription.includes('STICKER_VIDEO_BIG')) {
        messageText = i18n.t(lang, 'sticker.add.error.too_big')
      } else if (errDescription.includes('STICKER_PNG_NOPNG')) {
        messageText = i18n.t(lang, 'sticker.add.error.invalid_png')
      } else if (errDescription.includes('STICKER_PNG_DIMENSIONS')) {
        messageText = i18n.t(lang, 'sticker.add.error.invalid_dimensions')
      } else if (errDescription.includes('STICKER_TGS_NOTGS')) {
        messageText = i18n.t(lang, 'sticker.add.error.invalid_animated')
      } else if (errDescription.includes('STICKER_VIDEO_NOWEBM')) {
        messageText = i18n.t(lang, 'sticker.add.error.invalid_video')
      } else if (errDescription.includes('sticker not found')) {
        messageText = i18n.t(lang, 'sticker.add.error.sticker_not_found')
      } else if (errDescription.includes('STICKERSET_INVALID')) {
        messageText = i18n.t(lang, 'sticker.add.error.stickerset_invalid')
      } else {
        messageText = i18n.t(lang, 'error.telegram', {
          error: errDescription
        })
      }
    } else if (addStickerResult.error === 'ITS_ANIMATED') {
      messageText = i18n.t(lang, 'sticker.add.error.file_type')
    } else {
      messageText = i18n.t(lang, 'error.telegram', {
        error: addStickerResult.error
      })
    }
  }

  return {
    messageText,
    replyMarkup
  }
}
