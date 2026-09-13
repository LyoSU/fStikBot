// What a message carries for the sticker pipeline: its media file and the
// caption words that switch processing on. Pure functions — no I/O.

// A GIF sent from the bot's inline Tenor search carries its Tenor media URL as
// the caption. Only a real https Tenor URL may be downloaded: the caption is
// user-controlled.
const isTenorMediaUrl = (text) => {
  if (!text) return false
  try {
    const url = new URL(text.trim())
    return url.protocol === 'https:' && (url.hostname === 'tenor.com' || url.hostname.endsWith('.tenor.com'))
  } catch (_) {
    return false
  }
}

// "!" removes the background (photos only), "roundit" makes a round video
// sticker, "cropit" crops to a square. Whole words only — "Wow! 😂" used to
// send the photo through background removal because the check was
// caption.includes('!').
const CAPTION_FLAGS = { '!': 'removeBg', roundit: 'video_note', cropit: 'forceCrop' }

/**
 * @param {string} [caption]
 * @returns {{flags: {removeBg?: true, video_note?: true, forceCrop?: true}, text: string}}
 *   the flags found and the caption without them
 */
const parseCaption = (caption) => {
  const flags = {}
  const rest = (caption || '').split(/\s+/).filter((word) => {
    const flag = word && CAPTION_FLAGS[word.toLowerCase()]
    if (flag) flags[flag] = true
    return word && !flag
  })
  return { flags, text: rest.join(' ') }
}

/**
 * The sticker-able media on a message, as a fresh object — message objects are
 * shared with every other handler of the update. The order mirrors telegraf's
 * updateSubTypes: an animation message also carries `document` and must be
 * treated as the animation.
 *
 * @param {Object} [message]
 * @returns {Object|null} the file with `stickerType` set, or null
 */
const extractMedia = (message) => {
  if (!message) return null
  if (message.video_note) return { ...message.video_note, stickerType: 'video_note', video_note: true }
  if (message.video) return { ...message.video, stickerType: 'video' }
  if (message.animation) {
    const file = { ...message.animation, stickerType: 'animation' }
    if (isTenorMediaUrl(message.caption)) file.fileUrl = message.caption.trim()
    return file
  }
  if (message.sticker) return { ...message.sticker, stickerType: 'sticker' }
  if (message.photo && message.photo.length > 0) {
    return { ...message.photo[message.photo.length - 1], stickerType: 'photo' }
  }
  if (message.document) {
    const mime = message.document.mime_type || ''
    if (/^(image|video)\//.test(mime) && !/heic|heif/.test(mime)) {
      return { ...message.document, stickerType: 'document' }
    }
  }
  return null
}

module.exports = { parseCaption, extractMedia, isTenorMediaUrl }
