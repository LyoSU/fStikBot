const got = require('got')
const sharp = require('sharp')

// Download a sticker by file_id and reply with it as a regular document:
//   .webp → converted to PNG via sharp (Telegram clients preview it nicely)
//   .webm / .tgs → sent as-is
//
// Why a document and not a photo/video? Telegram rejects sticker file_ids
// on sendPhoto/sendVideo with "can't use file of type Sticker as Photo".
// Re-uploading via URL converts the file out of the Sticker type.
//
// Return values:
//   true          — sent successfully
//   false         — an error (download/telegram) was shown to the user
//   'unsupported' — file extension unrecognized, nothing was sent (caller decides)
async function sendStickerAsDocument (ctx, fileId, fileUniqueId, extra = {}) {
  let fileLink
  try {
    fileLink = await ctx.telegram.getFileLink(fileId)
    console.log('[sendStickerAsDocument] got file link', { fileUniqueId, fileLink: String(fileLink) })
  } catch (err) {
    console.log('[sendStickerAsDocument] getFileLink failed', { fileUniqueId, message: err.message })
    const key = err.message && err.message.includes('file is too big')
      ? 'error.file_too_big'
      : 'error.download'
    await ctx.replyWithHTML(ctx.i18n.t(key), extra).catch((e) =>
      console.log('[sendStickerAsDocument] replyWithHTML(error.download) failed', e.message))
    return false
  }

  const replyTelegramError = (error) =>
    ctx.replyWithHTML(
      ctx.i18n.t('error.telegram', { error: error.description || error.message }),
      extra
    ).catch((e) => console.log('[sendStickerAsDocument] replyWithHTML(error.telegram) failed', e.message))

  try {
    if (fileLink.endsWith('.webp')) {
      const buffer = await got(fileLink).buffer()
      const pngBuffer = await sharp(buffer, { failOnError: false }).png().toBuffer()
      await ctx.replyWithDocument({ source: pngBuffer, filename: `${fileUniqueId}.png` }, extra)
      console.log('[sendStickerAsDocument] sent webp→png document', { fileUniqueId })
      return true
    }
    if (fileLink.endsWith('.webm')) {
      await ctx.replyWithDocument({ url: fileLink, filename: `${fileUniqueId}.webm` }, extra)
      console.log('[sendStickerAsDocument] sent webm document', { fileUniqueId })
      return true
    }
    if (fileLink.endsWith('.tgs')) {
      await ctx.replyWithDocument({ url: fileLink, filename: `${fileUniqueId}.tgs` }, extra)
      console.log('[sendStickerAsDocument] sent tgs document', { fileUniqueId })
      return true
    }
    console.log('[sendStickerAsDocument] unsupported extension', { fileUniqueId, fileLink: String(fileLink) })
    return 'unsupported'
  } catch (error) {
    console.log('[sendStickerAsDocument] send failed', {
      fileUniqueId,
      description: error.description || error.message
    })
    await replyTelegramError(error)
    return false
  }
}

module.exports = sendStickerAsDocument
