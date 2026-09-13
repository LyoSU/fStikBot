// t.me link to a pack. Emoji packs live under addemoji/ — the hardcoded
// addstickers/ prefix that used to be scattered around opened an emoji pack as
// "sticker set not found".
const config = require('../config.json')

/**
 * @param {{name: string, packType?: string, sticker_type?: string}} pack
 *   a StickerSet doc or a Bot API StickerSet (which calls the type sticker_type)
 * @returns {string} link without the scheme, e.g. t.me/addemoji/foo_by_bot
 */
const packLink = (pack) => {
  const type = pack.packType || pack.sticker_type
  const prefix = type === 'custom_emoji' ? config.emojiLinkPrefix : config.stickerLinkPrefix
  return `${prefix}${pack.name}`
}

module.exports = packLink
