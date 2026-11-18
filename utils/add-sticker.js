const sharp = require('sharp')
const emojiRegex = require('emoji-regex')
const { db } = require('../database')
const { convertQueue, removebgQueue } = require('./queues')
const { runQueueJob } = require('./queue-job')
const { convertPriority, convertRank, maxVideoDuration, queueTooBusy } = require('./video-convert-rules')
const downloadFileByUrl = require('./download-file-by-url')
const { MAX_INPUT_PIXELS } = require('./image-limits')
const { fitStickerSize } = require('./sticker-geometry')
const { isVideoContainer, sniffMedia } = require('./sniff-media')
const { isInCopyScope } = require('./retry-api')
const { getStickerCooldown, buildCooldownError } = require('./sticker-cooldown')
const { canAddByFileId } = require('./file-id-reuse')
const { uploadSticker, tryAddByFileId, uploadRetargetedTgs, internalError } = require('./sticker-upload')
const { isVideoInput, isVideoNoteInput, initialFormat, urlPathname: pathOf, formatFromPath, hasImageExtension } = require('./sticker-format')
// Registers the convert-queue result handlers.
require('./convert-results')
const log = require('./logger').scope('add-sticker')

// Bot API hard limit on InputSticker.emoji_list
const MAX_EMOJI_LIST = 20

// Background removal for a "!" caption shares the /clear queue.
const REMOVEBG_TIMEOUT_MS = 60 * 1000

// addSticker return contract (single shape — caller always renders via
// addStickerText, addSticker never calls ctx.reply directly):
//
//   { ok: {...} }       — success
//   { wait: true, job } — queued to convertQueue; worker will reply later
//   { error: {...} }    — any of:
//     { type: 'duplicate', sticker }   — dup in inline pack (caller renders
//                                         inline buttons to delete/copy)
//     { telegram: <err> }              — Telegram API error (caller inspects
//                                         description for known codes)
//     { i18nKey: '<key>' }             — simple inline error; caller
//                                         renders i18n.t(key) verbatim.
//                                         Data-driven: adding a new inline
//                                         error = add an i18n key, no code
//                                         change in addStickerText.

// Telegram adds stickers only on behalf of the pack's owner (user_id of
// uploadStickerFile / addStickerToSet). A co-editor or a group member used
// their own id, and Telegram refused the add.
const resolveOwnerId = async (ctx, stickerSet) => {
  if (stickerSet?.ownerTelegramId) return stickerSet.ownerTelegramId
  const ownerRef = stickerSet?.owner?._id || stickerSet?.owner
  const owner = ownerRef && await db.User.findById(ownerRef).select('telegram_id').lean().catch(() => null)
  return owner?.telegram_id || ctx.from.id
}

// Per-user ordering and "one video at a time" for free users live in the
// caller's queue (handlers/sticker.js, utils/user-queue.js) — this function
// no longer keeps locks of its own that refused files.
//
// options.stickerSetInfo — a getStickerSet result the caller already fetched
// for this pack; reused as the "before" snapshot instead of fetching again.
// options.replyToMessageId — the user's message a queued conversion replies to.
module.exports = async (ctx, inputFile, toStickerSet, showResult = true, options = {}) => {
  let stickerFile = inputFile

  // If inputFile is already a sticker from a Telegram set, use it directly
  // (it's already converted and validated by Telegram)
  // Only look for original if it's a new file upload (no set_name)
  if (!stickerFile.set_name) {
    const originalSticker = await ctx.db.Sticker.findOne({
      fileUniqueId: stickerFile.file_unique_id
    })

    // Use original file if available (supports both new and legacy schema)
    // This preserves the chain: Pack A → Pack B → Pack C all point to original source
    if (originalSticker && originalSticker.hasOriginal()) {
      stickerFile = {
        file_id: originalSticker.getOriginalFileId(),
        file_unique_id: originalSticker.getOriginalFileUniqueId(),
        stickerType: originalSticker.getOriginalStickerType() || stickerFile.stickerType,
        // Preserve these fields for proper sticker type detection
        type: stickerFile.type,
        is_animated: stickerFile.is_animated,
        is_video: stickerFile.is_video
      }
    }
  }

  const stickerSet = toStickerSet
  const ownerId = await resolveOwnerId(ctx, stickerSet)

  if (stickerSet && stickerSet.inline) {
    if (!stickerFile?.file_unique_id) {
      return internalError(`inline add without file_unique_id (pack ${stickerSet.name})`)
    }

    // Duplicates are checked by the caller (handlers/sticker.js) before queueing.
    const sticker = await ctx.db.Sticker.addSticker(stickerSet.id, inputFile.emoji, stickerFile, null)

    return {
      ok: {
        inline: true,
        sticker,
        stickerSet
      }
    }
  }

  const emojis = []

  if (inputFile.emoji) {
    if (Array.isArray(inputFile.emoji)) {
      emojis.push(...inputFile.emoji)
    } else if (typeof inputFile.emoji === 'string') {
      const emojiList = inputFile.emoji.match(emojiRegex())

      if (emojiList) {
        emojis.push(...emojiList)
      }
    }
  }

  if (emojis.length === 0) {
    emojis.push(stickerSet.emojiSuffix)
  }

  // Bot API allows 1–20 emoji per sticker. A caption with 25 of them used to
  // come back as a raw Telegram error instead of just working.
  if (emojis.length > MAX_EMOJI_LIST) emojis.length = MAX_EMOJI_LIST

  // Every source of "this is a video" in one place (utils/sticker-format.js).
  let isVideo = isVideoInput(stickerFile, inputFile)
  const isVideoNote = isVideoNoteInput(stickerFile, inputFile)

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  // Bail before any download/convert work if this add would only fail again:
  // the user's sticker calls are in a 429 cooldown, or the file has to be
  // uploaded while the bot-wide upload cooldown is on. A file_id add uploads
  // nothing, so it still goes through during an upload flood. A pack copy
  // runs in copy scope and waits cooldowns out instead, so it skips this.
  if (!isInCopyScope()) {
    const cooldown = getStickerCooldown(ownerId, { upload: !canAddByFileId(stickerFile, stickerSet) })
    if (cooldown > 0) return { error: { telegram: buildCooldownError(cooldown) } }
  }

  // Reuse the caller's snapshot when it is for this very pack — every
  // getStickerSet is another server round-trip per sticker.
  const snapshot = options.stickerSetInfo
  const getStickerSetCheck = snapshot?.name && snapshot.name.toLowerCase() === stickerSet.name.toLowerCase()
    ? snapshot
    : await ctx.telegram.getStickerSet(stickerSet.name).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })
  if (getStickerSetCheck.error) {
    return getStickerSetCheck
  }

  const stickerExtra = {
    emojis
  }

  stickerExtra.sticker_format = initialFormat({ isAnimated: stickerFile.is_animated, isVideo, isVideoNote })

  if (stickerFile.is_animated) {
    // A TGS from any pack (or a restore of this pack's own file) fits as is,
    // so add it by file_id: no download, no upload.
    if (canAddByFileId(stickerFile, stickerSet)) {
      const byFileId = await tryAddByFileId(ownerId, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
      if (byFileId) return byFileId
    }

    const fileUrl = await ctx.telegram.getFileLink(stickerFile).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })

    if (fileUrl.error) {
      return fileUrl
    }

    return uploadRetargetedTgs(ownerId, stickerSet, stickerFile, stickerExtra, fileUrl, getStickerSetCheck.stickers)
  }

  // Static and video stickers from a set of the same type go by file_id too.
  // This path used to always re-upload because a wrong format guess made
  // Telegram answer "wrong file type"; set stickers carry reliable
  // is_video/is_animated flags, and a refusal still falls through to the
  // download path below, which corrects the format from the file extension.
  if (canAddByFileId(stickerFile, stickerSet)) {
    const byFileId = await tryAddByFileId(ownerId, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
    if (byFileId) return byFileId
  }

  // Non-animated stickers (static or video)
  let fileUrl
  let fileData

  if (stickerFile.fileUrl) {
    fileUrl = stickerFile.fileUrl
  } else {
    fileUrl = await ctx.telegram.getFileLink(stickerFile).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })

    if (fileUrl.error) {
      return fileUrl
    }
  }

  // The file's extension wins over flags that may be wrong.
  const urlPathname = pathOf(fileUrl)
  stickerExtra.sticker_format = formatFromPath(stickerExtra.sticker_format, urlPathname)

  // Handle animated stickers that weren't caught by is_animated check (fallback from URL detection)
  if (stickerExtra.sticker_format === 'animated' && !stickerFile.is_animated) {
    return uploadRetargetedTgs(ownerId, stickerSet, stickerFile, stickerExtra, fileUrl, getStickerSetCheck.stickers)
  }

  // A same-type set sticker gets here only after Telegram refused it by file_id
  // (see tryAddByFileId above): upload the file itself, with sticker_format
  // now corrected from the file extension.
  if (stickerFile.set_name && stickerFile.type === stickerSet.packType) {
    let stickerData
    try {
      stickerData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }
    stickerExtra.sticker = { source: stickerData }
    return uploadSticker(ownerId, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
  }

  // Remove background if requested
  if (inputFile.removeBg) {
    let priority = 10
    if (stickerSet?.boost) priority = 5
    else if (ctx.i18n.locale() === 'ru') priority = 15

    const removed = await runQueueJob(removebgQueue, { fileUrl }, { priority, timeoutMs: REMOVEBG_TIMEOUT_MS })

    if (removed.error) {
      return { error: { i18nKey: removed.error === 'timeout' ? 'sticker.add.error.timeout' : 'sticker.add.error.convert' } }
    }

    fileData = await sharp(Buffer.from(removed.result.content, 'base64'))
      .trim()
      .toBuffer()
  }

  // A file that comes through a stored original (restore / copy) has no
  // mime_type, duration or is_video, and legacy file_paths carry no extension
  // — so an mp4 original used to reach the static branch and die in
  // sharp.metadata as "invalid image". When nothing above identified the
  // type, look at the bytes; the static branch reuses the download.
  const urlHasImageExt = hasImageExtension(urlPathname)
  if (!isVideo && !isVideoNote && !fileData && !inputFile.mime_type &&
      stickerExtra.sticker_format === 'static' && !urlHasImageExt) {
    try {
      fileData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }

    if (isVideoContainer(fileData)) {
      isVideo = true
      stickerExtra.sticker_format = 'video'
      // The converter downloads by fileUrl itself; don't ship megabytes of
      // base64 through Redis.
      fileData = null
    }
  }

  // Determine if video processing is needed
  // Also check sticker_format === 'video' in case URL extension corrected the format
  const needsVideoProcessing = isVideo || isVideoNote ||
    stickerExtra.sticker_format === 'video' ||
    (stickerExtra.sticker_format === 'static' && stickerSet.frameType && stickerSet.frameType !== 'square')

  if (needsVideoProcessing) {
    // Size check for new files (stickers from sets are already validated)
    if (!stickerFile.set_name && (inputFile.file_size > 1000 * 1000 * 15 || inputFile.duration > 65)) {
      return { error: { i18nKey: 'sticker.add.error.too_big' } }
    }

    // Skip re-encoding if explicitly requested
    if (inputFile.skip_reencode) {
      let skipData
      try {
        skipData = await downloadFileByUrl(fileUrl)
      } catch (err) {
        return { error: { i18nKey: 'sticker.add.error.convert' } }
      }
      stickerExtra.sticker = { source: skipData }
      return uploadSticker(ownerId, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
    }

    // Convert video through queue
    if (stickerExtra.sticker_format === 'static') {
      stickerExtra.sticker_format = 'video'
    }

    const stickerSetsCount = await ctx.db.StickerSet.countDocuments({
      owner: ctx.session.userInfo._id,
      video: true
    })

    const owner = { videoPacks: stickerSetsCount, locale: ctx.i18n.locale(), boost: stickerSet?.boost }
    const priority = convertPriority(owner)
    const maxDuration = maxVideoDuration(stickerSet?.boost)
    const total = await convertQueue.getJobCounts()

    if (queueTooBusy(total.waiting, convertRank(owner))) {
      return { error: { i18nKey: 'sticker.add.error.timeout' } }
    }

    let convertingMessage
    if (!stickerSet?.boost && total.waiting > 5) {
      convertingMessage = await ctx.replyWithHTML(ctx.i18n.t('sticker.add.converting_process', {
        progress: total.waiting + 1,
        total: total.waiting + 1
      }), options.replyToMessageId
        ? { reply_to_message_id: options.replyToMessageId, allow_sending_without_reply: true }
        : {}
      ).catch(() => null)
    }

    let frameType = isVideoNote ? 'circle' : 'rounded'
    const forceCrop = inputFile.forceCrop || stickerSet.packType === 'custom_emoji'

    if (frameType === 'rounded') {
      frameType = stickerSet.frameType || 'square'
    }

    let job
    try {
      job = await convertQueue.add({
        input: {
          botId: ctx.botInfo.id,
          userId: ownerId,
          chatId: ctx.chat.id,
          replyToMessageId: options.replyToMessageId || null,
          actor: { id: ctx.from.id, first_name: ctx.from.first_name, last_name: ctx.from.last_name, username: ctx.from.username },
          locale: ctx.i18n.locale(),
          showResult,
          tracked: !!options.track,
          // Released by the convert handlers (see handlers/sticker.js addOne).
          claimKey: options.claimKey || null,
          convertingMessageId: convertingMessage ? convertingMessage.message_id : null,
          stickerExtra,
          stickerSet,
          stickerFile
        },
        fileUrl,
        fileData: fileData ? Buffer.from(fileData).toString('base64') : null,
        timestamp: Date.now(),
        isEmoji: stickerSet.packType === 'custom_emoji',
        frameType,
        forceCrop,
        maxDuration
      }, {
        priority,
        attempts: 1,
        removeOnComplete: true,
        // Keep a failed job for an hour rather than deleting it on failure:
        // Bull deletes the job hash BEFORE publishing global:failed, so with
        // `true` handleConvertFailed could never load the job — no error
        // reply, and the "converting" message stayed. The handler removes
        // the job itself; the age cap bounds what a missed event leaves
        // behind (jobs carry base64 fileData).
        removeOnFail: { age: 60 * 60 }
      })
    } catch (err) {
      // The "converting N/N" message would otherwise sit there for good.
      if (convertingMessage) {
        await ctx.telegram.deleteMessage(ctx.chat.id, convertingMessage.message_id).catch(() => {})
      }
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }

    return { wait: true, job }
  }

  if (!fileData) {
    try {
      fileData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }
  }

  if (!fileData || fileData.length === 0) {
    return { error: { i18nKey: 'sticker.add.error.invalid_image' } }
  }

  // A TGS whose legacy file_path has no extension and that carries no
  // is_animated flag (a stored original, a restore) got here and died in
  // sharp as "invalid image" (prod: `head: 1f8b…`, a gzip). It is an animated
  // sticker: send it down the TGS path with the bytes already downloaded.
  if (sniffMedia(fileData) === 'tgs') {
    stickerExtra.sticker_format = 'animated'
    return uploadRetargetedTgs(ownerId, stickerSet, stickerFile, stickerExtra, fileUrl, getStickerSetCheck.stickers, fileData)
  }

  const imageSharp = sharp(fileData, {
    failOn: 'none',
    limitInputPixels: MAX_INPUT_PIXELS,
    pages: 1
  })

  const imageMetadata = await imageSharp.metadata().catch((err) => {
    log.warn('sharp metadata failed:', err.message, 'bytes:', fileData?.length, 'head:', fileData?.slice(0, 20)?.toString('hex'))
    return null
  })

  if (!imageMetadata) {
    return { error: { i18nKey: 'sticker.add.error.invalid_image' } }
  }

  let pipeline = imageSharp.clone()

  if (stickerSet.packType === 'custom_emoji') {
    if (imageMetadata.width !== 100 || imageMetadata.height !== 100) {
      pipeline = pipeline.resize(100, 100, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
    }
  } else {
    // Longer side exactly 512, the other proportional. Small sources are
    // scaled UP — the old code centred them on a transparent 512×512
    // canvas, so a 100×100 custom emoji became a thumbnail-sized sticker.
    // See utils/sticker-geometry.js.
    const { width, height } = fitStickerSize(imageMetadata.width, imageMetadata.height)

    if (width !== imageMetadata.width || height !== imageMetadata.height) {
      pipeline = pipeline.resize(width, height, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3
      })
    }
  }

  stickerExtra.sticker = {
    source: await pipeline.png({ compressionLevel: 6, effort: 3 }).toBuffer()
  }

  return uploadSticker(ownerId, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
}

module.exports.resolveOwnerId = resolveOwnerId
