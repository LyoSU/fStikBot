const handleError = require('./catch')
const handleStart = require('./start')
const handleDonate = require('./donate')
const handleSticker = require('./sticker')
const handleDeleteSticker = require('./sticker-delete')
const handleRestoreSticker = require('./sticker-restore')
const handlePacks = require('./packs')
const handleHidePack = require('./pack-hide')
const handleRestorePack = require('./pack-restore')
const handleCopyPack = require('./pack-copy')
const handleLanguage = require('./language')
const handleEmoji = require('./emoji')

module.exports = {
  handleError,
  handleStart,
  handleDonate,
  handleSticker,
  handleDeleteSticker,
  handleRestoreSticker,
  handlePacks,
  handleHidePack,
  handleRestorePack,
  handleCopyPack,
  handleLanguage,
  handleEmoji
}
