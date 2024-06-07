const path = require('path')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

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
    if (addStickerResult.error.telegram) {
      if (!addStickerResult.error.telegram.description) {
        throw new Error(addStickerResult.error)
      } else if (addStickerResult.error.telegram.description.includes('TOO_MUCH')) {
        messageText = i18n.t(lang, 'sticker.add.error.stickers_too_much')
      } else if (addStickerResult.error.telegram.description.includes('STICKERSET_INVALID')) {
        messageText = i18n.t(lang, 'sticker.add.error.stickerset_invalid')
      } else if (addStickerResult.error.telegram.description.includes('file is too big')) {
        messageText = i18n.t(lang, 'sticker.add.error.too_big')
      } else {
        messageText = i18n.t(lang, 'error.telegram', {
          error: addStickerResult.error.telegram.description
        })
      }
    } else if (addStickerResult.error === 'ITS_ANIMATED') messageText = i18n.t(lang, 'sticker.add.error.file_type')
    else {
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
