// What kind of sticker a file becomes: 'static', 'video' or 'animated' (TGS).
// Pure — the add path (utils/add-sticker.js) feeds it what it knows, from the
// most direct evidence to the least: Telegram's own flags, the message's media
// type and mime, then the file's extension. The bytes are the last word
// (utils/sniff-media.js) when none of that is there.

/**
 * Whether the input has to go through the video converter, from what the
 * message and a stored original tell.
 *
 * @param {Object} stickerFile the file being added (possibly a stored original)
 * @param {Object} inputFile the file as the user sent it
 */
const isVideoInput = (stickerFile, inputFile) => {
  const stickerType = stickerFile.stickerType
  return !!(
    stickerFile.is_video ||
    stickerType === 'video' ||
    stickerType === 'video_note' ||
    inputFile.is_video ||
    (inputFile.mime_type && inputFile.mime_type.match('video')) ||
    inputFile.mime_type === 'image/gif' ||
    inputFile.duration > 0
  )
}

const isVideoNoteInput = (stickerFile, inputFile) => !!(inputFile.video_note || stickerFile.stickerType === 'video_note')

/** The format before the file itself has been looked at. */
const initialFormat = ({ isAnimated, isVideo, isVideoNote }) => {
  if (isAnimated) return 'animated'
  if (isVideo || isVideoNote) return 'video'
  return 'static'
}

/**
 * The path part of a file URL (query string dropped), or the string as is
 * when it isn't a URL.
 * @param {URL|string} fileUrl
 */
const urlPathname = (fileUrl) => {
  const text = fileUrl?.href || fileUrl?.toString() || ''
  try {
    if (text.startsWith('http')) return new URL(text).pathname
  } catch (_) { /* not a URL: keep the string */ }
  return text
}

/**
 * The format corrected by the file's extension, which wins over flags that
 * may be wrong. Legacy file paths have no extension: then nothing changes.
 */
const formatFromPath = (format, pathname) => {
  if (pathname.endsWith('.webm')) return 'video'
  if (pathname.endsWith('.tgs')) return 'animated'
  if (pathname.endsWith('.webp') || pathname.endsWith('.png')) return 'static'
  return format
}

const hasImageExtension = (pathname) => /\.(webp|png|jpe?g)$/i.test(pathname)

/** The format of a sticker as Telegram describes it (a Sticker object). */
const formatOfSticker = (sticker) => {
  if (sticker.is_animated) return 'animated'
  if (sticker.is_video) return 'video'
  return 'static'
}

module.exports = { isVideoInput, isVideoNoteInput, initialFormat, urlPathname, formatFromPath, hasImageExtension, formatOfSticker }
