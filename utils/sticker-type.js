// Sticker-set format flags from a getStickerSet response.
//
// Bot API 7.2 moved `is_animated` / `is_video` from the StickerSet onto each
// Sticker, and a set can mix formats since then. So a flag means "the set
// contains at least one such sticker", not "the set is of this format".

function deriveStickerFlags (stickers) {
  const list = Array.isArray(stickers) ? stickers : []
  return {
    animated: list.some((s) => s && s.is_animated),
    video: list.some((s) => s && s.is_video)
  }
}

module.exports = { deriveStickerFlags }
