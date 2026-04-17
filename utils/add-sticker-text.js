const path = require('path')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const escapeHTML = require('./html-escape')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

// Known Telegram API error description substrings → i18n key.
// Order matters only when substrings overlap — currently disjoint.
// Add a new known error = add a row. No branching in the rendering code.
const TELEGRAM_ERROR_MAP = [
  ['TOO_MUCH', 'sticker.add.error.stickers_too_much'],
  ['STICKERSET_INVALID', 'sticker.add.error.stickerset_invalid'],
  ['file is too big', 'sticker.add.error.too_big'],
  ['STICKER_VIDEO_BIG', 'sticker.add.error.too_big'],
  ['STICKER_PNG_NOPNG', 'sticker.add.error.invalid_png'],
  ['STICKER_PNG_DIMENSIONS', 'sticker.add.error.invalid_dimensions'],
  ['STICKER_TGS_NOTGS', 'sticker.add.error.invalid_animated'],
  ['STICKER_VIDEO_NOWEBM', 'sticker.add.error.invalid_video'],
  ['sticker not found', 'sticker.add.error.sticker_not_found']
]

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
    } else if (addStickerResult.error.i18nKey) {
      // Data-driven inline-error path: addSticker short-circuited with a
      // known i18n key (download failed, too big, queue full, etc.).
      // Adding a new inline error = add an i18n key, no code change here.
      messageText = i18n.t(lang, addStickerResult.error.i18nKey)
    } else if (addStickerResult.error.telegram) {
      const errDescription = addStickerResult.error.telegram.description || addStickerResult.error.telegram.message || ''
      if (!errDescription) {
        throw new Error(JSON.stringify(addStickerResult.error))
      }
      const hit = TELEGRAM_ERROR_MAP.find(([needle]) => errDescription.includes(needle))
      messageText = hit
        ? i18n.t(lang, hit[1])
        : i18n.t(lang, 'error.telegram', { error: errDescription })
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
