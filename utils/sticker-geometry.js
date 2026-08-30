// Output size for a static sticker.
//
// Telegram: one side must be exactly 512, the other ≤ 512. We scale by the
// longer side and keep the aspect ratio — small sources (a 100×100 custom
// emoji, a 300×200 screenshot) are scaled UP, not centred on a transparent
// 512×512 canvas. Padding made them render as a tiny picture in the middle of
// an otherwise empty sticker.

const STICKER_SIDE = 512

/**
 * @param {number} width  source width in px
 * @param {number} height source height in px
 * @returns {{ width: number, height: number }}
 */
function fitStickerSize (width, height) {
  if (width >= height) {
    return {
      width: STICKER_SIDE,
      height: Math.max(1, Math.round(height * STICKER_SIDE / width))
    }
  }
  return {
    width: Math.max(1, Math.round(width * STICKER_SIDE / height)),
    height: STICKER_SIDE
  }
}

module.exports = { fitStickerSize, STICKER_SIDE }
