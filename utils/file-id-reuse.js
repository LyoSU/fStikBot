const { matchTelegramErrorReason } = require('./telegram-error')

// Telegram reasons that mean "this file, sent this way, was refused" — the
// only failures a fresh upload of the same sticker can get past. Pack, emoji
// and limit errors would fail the upload path identically.
const FILE_REJECTION_REASONS = new Set(['invalid_sticker_format', 'sticker_not_in_set'])
// For a 400 we have no pattern for, retry only if it is about the file itself
// ("wrong file identifier", "Wrong file type", ...) — not e.g. USER_NOT_FOUND.
const FILE_ERROR_HINT = /file|sticker|document|media/i

const isFileRejection = (result) => {
  const error = result?.error?.telegram
  if (!error || error.code !== 400) return false
  const reason = matchTelegramErrorReason(error)
  if (reason === null) return FILE_ERROR_HINT.test(error.description || error.message || '')
  return FILE_REJECTION_REASONS.has(reason)
}

// A file_id can go straight into addStickerToSet when the file already has the
// canvas this pack expects: a sticker taken from a set of the same type, or a
// restore reusing this pack's own former file (sticker-restore sets
// reuse_file_id). No download, and no upload under the bot-wide upload flood.
// A TGS fits either pack type as is (both use the 512×512 canvas), so it goes
// by file_id across types too; measured: regular ⇄ custom_emoji is accepted.
// Static and video stickers still need the other type's size.
const canAddByFileId = (stickerFile, stickerSet) => (
  typeof stickerFile.reuse_file_id === 'string' || (
    !!stickerFile.set_name &&
    !!stickerFile.file_id &&
    (stickerFile.is_animated || stickerFile.type === (stickerSet.packType || 'regular'))
  )
)

// createNewStickerSet / callApi throw the raw TelegramError (code, description),
// while isFileRejection reads an addSticker result — adapt one to the other.
const isFileRejectionError = (error) => isFileRejection({ error: { telegram: error } })

const stickerFormatOf = (sticker) => {
  if (sticker.is_animated) return 'animated'
  if (sticker.is_video) return 'video'
  return 'static'
}

const emojiListOf = (sticker) => (sticker.emojis ? sticker.emojis : [sticker.emoji])

// The seed batch of a same-type copy, in source order. A sticker that can go
// in by file_id becomes its InputSticker right away (no download, no upload
// under the bot-wide upload flood); the rest keep `entry: null` and are
// re-uploaded by the caller. `source` stays for the re-upload fallback.
const buildSeedPlan = (batch, packType) => batch.map((source) => ({
  source,
  entry: canAddByFileId(source, { packType })
    ? { sticker: source.file_id, format: stickerFormatOf(source), emoji_list: emojiListOf(source) }
    : null
}))

module.exports = { canAddByFileId, isFileRejection, isFileRejectionError, buildSeedPlan, stickerFormatOf, emojiListOf }
