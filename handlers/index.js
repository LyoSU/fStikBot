module.exports = {
  handleError: require('./catch'),
  handleStart: require('./start'),
  handleDonate: require('./donate'),
  handleSticker: require('./sticker'),
  handleDeleteSticker: require('./sticker-delete'),
  handleRestoreSticker: require('./sticker-restore'),
  handlePacks: require('./packs'),
  handleHidePack: require('./pack-hide'),
  handleRestorePack: require('./pack-restore'),
  handleCopyPack: require('./pack-copy'),
  handleLanguage: require('./language'),
  handleEmoji: require('./emoji'),
  handleStickerUpade: require('./sticker-update'),
  handlePublish: require('./publish'),
  handleInlineQuery: require('./inline-query')
}
