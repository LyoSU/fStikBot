const Markup = require('telegraf/markup')
const {
  addSticker
} = require('../utils')
const { humanizeTelegramError } = require('../utils/telegram-error')
const { safeEditMessage } = require('../utils/safe-edit')
const coedit = require('../utils/coedit')
const publicPackLimit = require('../utils/public-pack-limit')
const inflight = require('../utils/inflight-adds')

// A callback alert shows text as is: no HTML.
const plain = (text) => text.replace(/<[^>]+>/g, '').trim()

// Prod 2026-11-17: 2076 of 2712 duplicate stickers in a day came through this
// button. The callback is answered only once the add is done (seconds), so the
// spinner looked stuck and people tapped again — three copies of one video in
// one second — and the message kept a "Copy" button after every restore.
// One add per (pack, file) at a time now — the same claim a sent file takes
// (handlers/sticker.js), held through a conversion; a restore that would
// re-add a file already live in the pack is refused; a restored sticker
// offers no "Copy".
module.exports = async (ctx) => {
  const sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet', '_id name title inline animated video packType emojiSuffix frameType boost owner placeholderFileUniqueId passcode')

  if (!sticker || !sticker.stickerSet) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }

  // One button, two actions: on a deleted sticker it undoes the delete, so it
  // takes the delete right; on a live one it is "copy", another add.
  const action = sticker.deleted ? 'delete' : 'add'
  if (!await coedit.allowed(ctx, sticker.stickerSet, action)) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  if (publicPackLimit.isPublic(sticker.stickerSet) && !publicPackLimit.take(ctx.from.id)) {
    return ctx.answerCbQuery(ctx.i18n.t('ratelimit'), true)
  }

  const sourceUid = sticker.getOriginalFileUniqueId() || sticker.fileUniqueId
  const claimKey = inflight.claim(sticker.stickerSet._id, sourceUid)
  if (claimKey === false) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.in_progress')).catch(() => {})
  }
  const claim = { key: claimKey, handedOver: false }
  try {
    return await restoreClaimed(ctx, sticker, sourceUid, claim)
  } finally {
    // A queued conversion owns the claim from here (utils/convert-results.js).
    if (!claim.handedOver) inflight.release(claimKey)
  }
}

const restoreClaimed = async (ctx, sticker, sourceUid, claim) => {
  const wasDeleted = sticker.deleted
  let newFileUniqueId

  // Undoing a delete must not add a second copy: the user may have sent the
  // same file again since. ("Copy" on a live sticker is an explicit second copy.)
  if (wasDeleted) {
    if (await ctx.db.Sticker.findLiveBySource(sticker.stickerSet._id, sourceUid, { except: sticker._id })) {
      return ctx.answerCbQuery(plain(ctx.i18n.t('sticker.add.error.have_already')), true)
    }
  }

  if (sticker.stickerSet.inline === true) {
    // Inline stickers - just mark as not deleted
    sticker.deleted = false
    sticker.deletedAt = null
    await sticker.save()

    await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'), true)
    newFileUniqueId = sticker.fileUniqueId
  } else {
    // Regular stickers - need to re-add to Telegram
    const currentFileId = sticker.getFileId()
    const stickerFile = await ctx.telegram.getFile(currentFileId).catch(() => null)

    if (!stickerFile) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

    // Legacy file_paths have no extension at all (e.g. `stickers/file_303092`).
    // split('.').pop() then returned the whole path, which fell into the video
    // branch below and made a static webp fail with STICKER_VIDEO_NOWEBM.
    // Only treat it as an extension when the last path segment really has one.
    const lastSegment = (stickerFile.file_path || '').split('/').pop()
    const fileExtension = lastSegment.includes('.')
      ? lastSegment.split('.').pop().toLowerCase()
      : null

    // Build file object for addSticker
    const originalFileId = sticker.getOriginalFileId() || currentFileId
    const originalFileUniqueId = sticker.getOriginalFileUniqueId() || sticker.fileUniqueId

    const fileForRestore = {
      file_id: originalFileId,
      file_unique_id: originalFileUniqueId
    }

    // No extension → fall back to what we know about the pack and the stored
    // media type instead of guessing "video".
    const storedType = typeof sticker.getStickerType === 'function' ? sticker.getStickerType() : null
    const looksVideo = fileExtension
      ? !['tgs', 'png', 'webp', 'jpg', 'jpeg'].includes(fileExtension)
      : (sticker.stickerSet.video === true || ['video', 'video_note', 'animation'].includes(storedType))
    const looksAnimated = fileExtension
      ? fileExtension === 'tgs'
      : sticker.stickerSet.animated === true

    // Determine format and set flags
    if (looksAnimated) {
      fileForRestore.is_animated = true
      // Try this pack's own former file first: it already has the canvas the
      // pack expects, so it goes in by file_id with no download or upload.
      // The original stays as file_id for the re-upload fallback.
      fileForRestore.reuse_file_id = currentFileId
    } else if (looksVideo) {
      // Video format
      fileForRestore.is_video = true
      // For video, use current file_id and skip re-encoding
      fileForRestore.file_id = currentFileId
      fileForRestore.skip_reencode = true
    }
    // else: static — no additional flags needed

    const result = await addSticker(ctx, fileForRestore, sticker.stickerSet, true, { claimKey: claim.key })

    if (result?.error) {
      const description = result.error.telegram?.description || result.error.telegram?.message || ''

      if (result.error.type === 'duplicate') {
        return ctx.answerCbQuery(plain(ctx.i18n.t('sticker.add.error.have_already')), true)
      } else if (result.error.type === 'unconfirmed') {
        return ctx.answerCbQuery(plain(ctx.i18n.t('sticker.add.error.unconfirmed')), true)
      } else if (description.includes('STICKERSET_INVALID')) {
        return ctx.answerCbQuery(ctx.i18n.t('callback.pack.error.copy'), true)
      } else if (result.error.telegram) {
        return ctx.answerCbQuery(humanizeTelegramError(ctx, result.error.telegram), true)
      } else if (result.error.i18nKey) {
        return ctx.answerCbQuery(ctx.i18n.t(result.error.i18nKey), true)
      }

      // uploadSticker's { error: { message } } shape used to fall through every
      // branch above and end up reporting "successfully restored".
      return ctx.answerCbQuery(ctx.i18n.t('error.unknown'), true)
    }

    // Queued for conversion (e.g. a static sticker in a framed pack): the
    // convert worker adds it and sends its own reply. Reporting "unknown
    // error" here used to be followed seconds later by "sticker added".
    if (result?.wait) {
      claim.handedOver = !!result.job
      return ctx.answerCbQuery()
    }

    newFileUniqueId = result?.ok?.stickerInfo?.file_unique_id
  }

  if (!newFileUniqueId) {
    return ctx.answerCbQuery(ctx.i18n.t('error.unknown'), true)
  }

  if (wasDeleted) {
    // Back under another file_unique_id: the archived row is marked so Studio
    // doesn't offer it again. Under the same one it is live again, so it
    // keeps no place from its earlier delete.
    const archive = newFileUniqueId !== sticker.fileUniqueId
      ? { $set: { restoredAt: new Date() } }
      : { $unset: { deletedPosition: '', deletedAfter: '', restoredAt: '' } }
    await ctx.db.Sticker.updateOne({ _id: sticker._id }, archive).catch(() => {})
  }

  coedit.track(ctx.db, sticker.stickerSet, ctx.from, 'restore', { fileUniqueId: newFileUniqueId })
  await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.restored'))

  // Only "Delete" from here: a "Copy" under every restored sticker made each
  // extra tap one more duplicate. (Third arg of callbackButton is `hide`.)
  await safeEditMessage(ctx, ctx.i18n.t('callback.sticker.restored'), {
    reply_markup: Markup.inlineKeyboard([
      { ...Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${newFileUniqueId}`), style: 'danger' }
    ])
  })
}
