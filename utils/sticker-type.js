// Derives sticker-set format from a Telegram getStickerSet response.
//
// Bot API 7.2 (April 2024) removed the top-level `is_animated` / `is_video`
// fields from the StickerSet object. The format now lives only on each
// individual Sticker (`sticker.is_animated` / `sticker.is_video`). Sets are
// homogeneous in format, so the first sticker is authoritative.

function deriveStickerFlags (stickers) {
  const first = Array.isArray(stickers) ? stickers[0] : null
  return {
    animated: !!(first && first.is_animated),
    video: !!(first && first.is_video)
  }
}

function flagsToType (flags) {
  if (!flags) return 'image'
  if (flags.animated) return 'animated'
  if (flags.video) return 'video'
  return 'image'
}

function stickerSetType (stickers) {
  return flagsToType(deriveStickerFlags(stickers))
}

module.exports = { deriveStickerFlags, flagsToType, stickerSetType }
