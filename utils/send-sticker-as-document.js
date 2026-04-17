const got = require('got')
const sharp = require('sharp')

// Download a sticker by file_id and reply with it as a regular document.
// Re-uploading converts the file out of Telegram's "Sticker" type so it
// can be forwarded/saved as an ordinary file.
//
// Dispatch by the URL extension when present (fast path — webm/tgs are
// forwarded by URL without a download). Otherwise download the bytes and
// sniff the format: Telegram's getFile sometimes returns legacy file_paths
// without an extension (e.g. `stickers/file_303092`) where extension-only
// dispatch produces a silent no-op.

// Returns true on success, false if an error was surfaced to the user.
async function sendStickerAsDocument (ctx, fileId, fileUniqueId, extra = {}) {
  let fileLink
  try {
    fileLink = await ctx.telegram.getFileLink(fileId)
  } catch (err) {
    const key = err.message && err.message.includes('file is too big')
      ? 'error.file_too_big'
      : 'error.download'
    await ctx.replyWithHTML(ctx.i18n.t(key), extra).catch(() => {})
    return false
  }

  const replyTelegramError = (error) =>
    ctx.replyWithHTML(
      ctx.i18n.t('error.telegram', { error: error.description || error.message }),
      extra
    ).catch(() => {})

  // Fast path: URL-forwarded document for the two sticker formats that don't
  // need re-encoding. Telegram clients preview these inline from the filename.
  try {
    if (fileLink.endsWith('.webm')) {
      await ctx.replyWithDocument({ url: fileLink, filename: `${fileUniqueId}.webm` }, extra)
      return true
    }
    if (fileLink.endsWith('.tgs')) {
      await ctx.replyWithDocument({ url: fileLink, filename: `${fileUniqueId}.tgs` }, extra)
      return true
    }
  } catch (error) {
    await replyTelegramError(error)
    return false
  }

  // Slow path: download and sniff. Covers .webp (converted to PNG for inline
  // preview) and legacy file_paths without an extension.
  let buffer
  try {
    buffer = await got(fileLink).buffer()
  } catch (err) {
    await ctx.replyWithHTML(ctx.i18n.t('error.download'), extra).catch(() => {})
    return false
  }

  const sniffed = sniffStickerFormat(buffer)

  try {
    if (sniffed === 'webp') {
      const pngBuffer = await sharp(buffer, { failOnError: false }).png().toBuffer()
      await ctx.replyWithDocument({ source: pngBuffer, filename: `${fileUniqueId}.png` }, extra)
      return true
    }
    // webm/tgs reached here when URL had no extension; mp4/jpg/png cover
    // legacy "original input" blobs (user uploaded a jpg, bot kept its file_id).
    const ext = sniffed || 'bin'
    await ctx.replyWithDocument({ source: buffer, filename: `${fileUniqueId}.${ext}` }, extra)
    return true
  } catch (error) {
    await replyTelegramError(error)
    return false
  }
}

// Recognize the formats Telegram actually stores in sticker-adjacent files.
// Magic-byte reference: https://en.wikipedia.org/wiki/List_of_file_signatures
function sniffStickerFormat (buffer) {
  if (!buffer || buffer.length < 12) return null
  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp'
  // WebM (EBML): 1A 45 DF A3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'webm'
  // TGS is gzipped JSON: 1F 8B
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) return 'tgs'
  // MP4 (ftyp box at offset 4)
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'mp4'
  // JPEG: FF D8
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg'
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png'
  return null
}

module.exports = sendStickerAsDocument
