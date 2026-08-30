const path = require('path')
const sharp = require('sharp')
const I18n = require('telegraf-i18n')
const emojiRegex = require('emoji-regex')
const { db } = require('../database')
const config = require('../config.json')
const addStickerText = require('../utils/add-sticker-text')
const telegram = require('./telegram')
const { convertQueue, removebgQueue } = require('./queues')
const downloadFileByUrl = require('./download-file-by-url')
const { removePlaceholderIfPending } = require('./placeholder')
const escapeHTML = require('./html-escape')
const { rescaleTgs } = require('./lottie-rescale')
const { fitStickerSize } = require('./sticker-geometry')
const { isVideoContainer } = require('./sniff-media')

// Telegram pins the Lottie canvas per pack type. A TGS taken from a pack of
// the other type has to be retargeted or Telegram rejects it.
const TGS_CANVAS = { custom_emoji: 100, regular: 512 }

const retargetTgs = (buffer, stickerSet) => {
  const target = TGS_CANVAS[stickerSet.packType] || TGS_CANVAS.regular
  return rescaleTgs(buffer, target)
}

// Track users with video currently processing (userId -> timestamp)
const videoProcessing = new Map()
const VIDEO_PROCESSING_TTL = 1000 * 60 * 2 // 2 minutes auto-unlock

// Bot API hard limit on InputSticker.emoji_list
const MAX_EMOJI_LIST = 20

// Lost global:completed/global:failed events would otherwise leave entries in
// videoProcessing forever. Sweep anything past the TTL.
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of videoProcessing) {
    if (now - value > VIDEO_PROCESSING_TTL) videoProcessing.delete(key)
  }
}, 1000 * 60).unref()

let botInfo = null
telegram.getMe().then((info) => {
  botInfo = info
})

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

// addSticker return contract (single shape — caller always renders via
// addStickerText, addSticker never calls ctx.reply directly):
//
//   { ok: {...} }       — success
//   { wait: true }      — queued to convertQueue; worker will reply later
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

// Update queue position messages when jobs complete (event-driven, not polling)
//
// Bounded on both axes: at most one pass every QUEUE_MESSAGE_THROTTLE_MS and at
// most QUEUE_MESSAGE_MAX edits per pass. With 200 waiting jobs the unbounded
// version issued up to 200 editMessageText per completed job and 429'd itself.
const QUEUE_MESSAGE_THROTTLE_MS = 3000
const QUEUE_MESSAGE_MAX = 20
let lastQueueMessageUpdate = 0

async function updateConvertQueueMessages () {
  const now = Date.now()
  if (now - lastQueueMessageUpdate < QUEUE_MESSAGE_THROTTLE_MS) return
  lastQueueMessageUpdate = now

  try {
    const waiting = await convertQueue.getWaiting()

    const limit = Math.min(waiting.length, QUEUE_MESSAGE_MAX)

    for (let i = 0; i < limit; i++) {
      const job = waiting[i]
      if (job?.data?.input?.convertingMessageId) {
        const { input } = job.data

        await telegram.editMessageText(input.chatId, input.convertingMessageId, null, i18n.t(input.locale || 'en', 'sticker.add.converting_process', {
          progress: i + 1,
          total: waiting.length
        }), {
          parse_mode: 'HTML'
        }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('updateConvertQueueMessages error:', err.message)
  }
}

// Trigger queue position updates only when a slot frees (completion shifts remaining waiting jobs).
// global:failed/global:active previously duplicated this work and hammered Telegram with edits.
convertQueue.on('global:completed', () => {
  updateConvertQueueMessages().catch((err) => console.error('updateConvertQueueMessages error:', err.message))
})

convertQueue.on('global:completed', (jobId, result) => {
  handleConvertCompleted(jobId, result).catch((err) => {
    console.error('convertQueue global:completed handler failed:', err?.stack || err)
  })
})

async function handleConvertCompleted (jobId, result) {
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (err) {
    console.error('convertQueue global:completed: bad payload:', err.message)
    return
  }

  const { input, metadata, content } = parsed

  if (!input) return

  // global:* fires in EVERY process attached to this Redis queue. Without this
  // guard each replica ran uploadSticker for the same job — double adds and
  // duplicate failure replies.
  if (input.botId && botInfo?.id && input.botId !== botInfo.id) return

  videoProcessing.delete(input.userId)

  const stickerExtra = input.stickerExtra

  // Handle case when conversion failed (no metadata/content)
  if (!metadata || !content) {
    if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), {
      parse_mode: 'HTML'
    }).catch(() => {})
    return
  }

  stickerExtra.sticker = {
    source: Buffer.from(content, 'base64')
  }

  // input.stickerSet is a plain object here — Bull serialized the job to JSON
  // in Redis, so it lost its Mongoose document methods (e.g. .save()) that
  // uploadSticker relies on. Re-fetch the live document before calling it.
  const stickerSet = await db.StickerSet.findById(input.stickerSet._id)

  if (!stickerSet) {
    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), {
      parse_mode: 'HTML'
    }).catch(() => {})
    return
  }

  const uploadResult = await uploadSticker(input.userId, stickerSet, input.stickerFile, stickerExtra)

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

  if (input.showResult) {
    const textResult = addStickerText(uploadResult, input.locale || 'en')

    if (textResult.messageText) {
      await telegram.sendMessage(input.chatId, textResult.messageText, {
        parse_mode: 'HTML',
        reply_markup: textResult.replyMarkup
      }).catch((err) => console.error('convert result reply failed:', err.message))
    }
  }
}

convertQueue.on('global:failed', (jobId, errorData) => {
  handleConvertFailed(jobId, errorData).catch((err) => {
    console.error('convertQueue global:failed handler failed:', err?.stack || err)
  })
})

async function handleConvertFailed (jobId, errorData) {
  const job = await convertQueue.getJob(jobId)
  if (!job) return

  const { input } = job.data || {}
  if (!input) return

  // Same reason as global:completed — one owner per job, or every replica
  // messages the user.
  if (input.botId && botInfo?.id && input.botId !== botInfo.id) return

  if (input.userId) videoProcessing.delete(input.userId)

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

  if (errorData === 'timeout') {
    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.timeout'), {
      parse_mode: 'HTML'
    }).catch(() => {})
  } else {
    await telegram.sendMessage(config.logChatId, `<b>Convert error</b>\n\n<code>${escapeHTML(JSON.stringify(errorData))}</code>`, {
      parse_mode: 'HTML'
    }).catch(() => {})

    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), {
      parse_mode: 'HTML'
    }).catch(() => {})
  }

  await job.remove().catch(() => {})
}

// `beforeStickers` is the set's sticker list as it looked immediately before
// this add (the caller usually already has it). Passing it lets us identify the
// sticker WE added instead of assuming it's the last one — with two concurrent
// adds to the same pack, slice(-1)[0] mapped both DB rows onto the same file.
const uploadSticker = async (userId, stickerSet, stickerFile, stickerExtra, beforeStickers) => {
  let stickerAdd

  // Validate stickerExtra has required fields
  if (!stickerExtra || !stickerExtra.sticker) {
    return {
      error: {
        message: 'Invalid sticker data: sticker is undefined'
      }
    }
  }

  const { sticker } = stickerExtra

  if (sticker?.source) {
    const uploadedSticker = await telegram.callApi('uploadStickerFile', {
      user_id: userId,
      sticker_format: stickerExtra.sticker_format,
      sticker: {
        source: sticker.source
      }
    }).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })

    if (uploadedSticker.error) {
      return uploadedSticker
    }

    stickerExtra.sticker = uploadedSticker.file_id
  }

  // Final validation before API call
  if (!stickerExtra.sticker) {
    return {
      error: {
        message: 'Sticker file not uploaded properly'
      }
    }
  }

  if (stickerSet.create === false) {
    stickerAdd = await telegram.callApi('createNewStickerSet', {
      user_id: userId,
      name: stickerSet.name,
      title: stickerSet.title,
      stickers: [{
        sticker: stickerExtra.sticker,
        format: stickerExtra.sticker_format,
        emoji_list: stickerExtra.emojis
      }],
      sticker_type: stickerSet.packType === 'custom_emoji' ? 'custom_emoji' : 'regular'
    }).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })
    if (stickerAdd.error) {
      return stickerAdd
    }
    if (stickerAdd) {
      stickerSet.create = true
      await stickerSet.save()
    }
  } else {
    stickerAdd = await telegram.callApi('addStickerToSet', {
      user_id: userId,
      name: stickerSet.name,
      sticker: {
        format: stickerExtra.sticker_format,
        sticker: stickerExtra.sticker,
        emoji_list: stickerExtra.emojis
      }
    }).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })

    if (stickerAdd.error) {
      return stickerAdd
    }
  }

  if (stickerAdd) {
    const getStickerSet = await telegram.getStickerSet(stickerSet.name).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })
    if (getStickerSet.error) {
      return getStickerSet
    }

    if (!getStickerSet.stickers || getStickerSet.stickers.length === 0) {
      return {
        error: {
          message: 'Sticker set is empty after adding sticker'
        }
      }
    }

    // A real sticker just landed — safe to drop the bootstrap placeholder now.
    await removePlaceholderIfPending(telegram, stickerSet, getStickerSet)

    const beforeIds = new Set(
      Array.isArray(beforeStickers) ? beforeStickers.map((s) => s.file_unique_id) : []
    )
    const added = beforeIds.size > 0
      ? getStickerSet.stickers.filter((s) => !beforeIds.has(s.file_unique_id))
      : []
    // Fall back to "last sticker" when we have no before-snapshot (e.g. the
    // convert-queue path) or the diff came out empty.
    const stickerInfo = added.length > 0
      ? added[added.length - 1]
      : getStickerSet.stickers.slice(-1)[0]

    const sticker = await db.Sticker.addSticker(stickerSet._id, stickerExtra.emojis, stickerInfo, stickerFile)

    const linkPrefix = stickerSet.packType === 'custom_emoji' ? config.emojiLinkPrefix : config.stickerLinkPrefix

    return {
      ok: {
        title: stickerSet.title,
        link: `${linkPrefix}${stickerSet.name}`,
        stickerInfo,
        sticker,
        // A monochrome (needs_repainting) emoji dropped into a regular sticker
        // pack stays white-on-transparent — nothing repaints it there. Surface
        // that in the success text so the user isn't puzzled by a "blank"
        // sticker on a light background.
        repainting: !!stickerFile?.needs_repainting && stickerSet.packType !== 'custom_emoji'
      }
    }
  }
}

// Rate limiting for static stickers (userId -> timestamp)
const lastStickerTime = new Map()
const STICKER_COOLDOWN = 1000 * 30 // 30 seconds

// Periodic cleanup of old entries (every 5 minutes).
// .unref() so this janitorial timer doesn't keep the process alive on shutdown.
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of lastStickerTime) {
    if (now - value > STICKER_COOLDOWN * 2) {
      lastStickerTime.delete(key)
    }
  }
}, 1000 * 60 * 5).unref()

module.exports = async (ctx, inputFile, toStickerSet, showResult = true) => {
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
        set_name: stickerFile.set_name,
        type: stickerFile.type,
        is_animated: stickerFile.is_animated,
        is_video: stickerFile.is_video
      }
    }
  }

  const stickerSet = toStickerSet

  if (stickerSet && stickerSet.inline) {
    // Validate file_unique_id exists
    if (!stickerFile?.file_unique_id) {
      return {
        error: {
          message: 'Invalid sticker file: missing file_unique_id'
        }
      }
    }

    // Check for duplicates in inline pack (by fileUniqueId, original.fileUniqueId, or legacy file.file_unique_id)
    const existingSticker = await ctx.db.Sticker.findOne({
      stickerSet: stickerSet.id,
      deleted: false,
      $or: [
        { fileUniqueId: stickerFile.file_unique_id },
        { 'original.fileUniqueId': stickerFile.file_unique_id },
        { 'file.file_unique_id': stickerFile.file_unique_id }
      ]
    })

    if (existingSticker) {
      return {
        error: {
          type: 'duplicate',
          sticker: existingSticker
        }
      }
    }

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

  // Unified video detection - check all possible sources
  const stickerType = stickerFile.stickerType
  let isVideo =
    stickerFile.is_video ||
    stickerType === 'video' ||
    stickerType === 'video_note' ||
    inputFile.is_video ||
    !!(inputFile.mime_type && inputFile.mime_type.match('video')) ||
    inputFile.mime_type === 'image/gif' ||
    inputFile.duration > 0
  const isVideoNote = inputFile.video_note || stickerType === 'video_note'

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const getStickerSetCheck = await ctx.telegram.getStickerSet(stickerSet.name).catch((error) => {
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

  if (stickerFile.is_animated) {
    stickerExtra.sticker_format = 'animated'
  } else if (isVideo || isVideoNote) {
    stickerExtra.sticker_format = 'video'
  } else {
    stickerExtra.sticker_format = 'static'
  }

  if (stickerFile.is_animated) {
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

    let animatedData
    try {
      animatedData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }

    const retargeted = retargetTgs(animatedData, stickerSet)
    if (retargeted.error) return retargeted

    stickerExtra.sticker = { source: retargeted.buffer }
    return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
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

  // Verify sticker_format matches actual file format (fallback check via URL extension)
  // This catches cases where is_video/is_animated might be incorrectly set
  const fileUrlStr = fileUrl?.href || fileUrl?.toString() || ''
  // Extract pathname to handle URLs with query parameters
  let urlPathname = fileUrlStr
  try {
    if (fileUrlStr.startsWith('http')) {
      urlPathname = new URL(fileUrlStr).pathname
    }
  } catch (e) {
    // Keep original string if URL parsing fails
  }

  if (urlPathname.endsWith('.webm') && stickerExtra.sticker_format !== 'video') {
    stickerExtra.sticker_format = 'video'
  } else if (urlPathname.endsWith('.tgs') && stickerExtra.sticker_format !== 'animated') {
    stickerExtra.sticker_format = 'animated'
  } else if ((urlPathname.endsWith('.webp') || urlPathname.endsWith('.png')) && stickerExtra.sticker_format !== 'static') {
    stickerExtra.sticker_format = 'static'
  }

  // Handle animated stickers that weren't caught by is_animated check (fallback from URL detection)
  if (stickerExtra.sticker_format === 'animated' && !stickerFile.is_animated) {
    let animatedData
    try {
      animatedData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }

    const retargeted = retargetTgs(animatedData, stickerSet)
    if (retargeted.error) return retargeted

    stickerExtra.sticker = { source: retargeted.buffer }
    return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
  }

  // For stickers already in a Telegram set with matching type - use directly
  if (stickerFile.set_name && stickerFile.type === stickerSet.packType) {
    // Always download and re-upload to ensure format consistency
    // Using file_id directly can cause "wrong file type" errors when
    // sticker_format doesn't match the actual file format
    let stickerData
    try {
      stickerData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }
    stickerExtra.sticker = { source: stickerData }
    return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
  }

  // Remove background if requested
  if (inputFile.removeBg) {
    let priority = 10
    if (stickerSet?.boost) priority = 5
    else if (ctx.i18n.locale() === 'ru') priority = 15

    let job
    try {
      job = await removebgQueue.add({
        fileUrl
      }, {
        priority,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true
      })
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }

    // Same pattern as scenes/photo-clear.js: race job.finished() against a
    // timeout that RESOLVES with a sentinel (a rejecting loser becomes an
    // unhandled rejection once the race is decided). Without this the caller's
    // in-flight slot stayed taken until the process restarted.
    const TIMEOUT = Symbol('timeout')
    let timer
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), 1000 * 60)
    })
    const jobPromise = job.finished().catch(() => null)
    const raceResult = await Promise.race([jobPromise, timeoutPromise])
    clearTimeout(timer)

    if (raceResult === TIMEOUT || !raceResult || !raceResult.content) {
      return { error: { i18nKey: 'sticker.add.error.timeout' } }
    }

    fileData = await sharp(Buffer.from(raceResult.content, 'base64'))
      .trim()
      .toBuffer()
  }

  // A file that comes through a stored original (restore / copy) has no
  // mime_type, duration or is_video, and legacy file_paths carry no extension
  // — so an mp4 original used to reach the static branch and die in
  // sharp.metadata as "invalid image". When nothing above identified the
  // type, look at the bytes; the static branch reuses the download.
  const urlHasImageExt = /\.(webp|png|jpe?g)$/i.test(urlPathname)
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
    // Check if user already has video processing (with auto-unlock after TTL)
    const lastProcessing = videoProcessing.get(ctx.from.id)
    if (lastProcessing && (Date.now() - lastProcessing < VIDEO_PROCESSING_TTL) && !stickerSet?.boost) {
      return { error: { i18nKey: 'sticker.add.error.wait_load' } }
    }

    // Take the lock right after the check. It used to be set only after
    // convertQueue.add — four awaits later — so double-tapping the same GIF
    // converted and added it twice. Released in the finally below on every
    // path that doesn't actually enqueue.
    videoProcessing.set(ctx.from.id, Date.now())
    let queued = false

    try {
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
        return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
      }

      // Convert video through queue
      if (stickerExtra.sticker_format === 'static') {
        stickerExtra.sticker_format = 'video'
      }

      const stickerSetsCount = await ctx.db.StickerSet.countDocuments({
        owner: ctx.session.userInfo._id,
        video: true
      })

      let priority = Math.round(stickerSetsCount / 3)
      if (ctx.i18n.locale() === 'ru') priority += 40
      if (stickerSet?.boost) priority = 5

      const maxDuration = stickerSet?.boost ? 35 : 4
      const total = await convertQueue.getJobCounts()

      if (total.waiting > 200 && priority > 50) {
        return { error: { i18nKey: 'sticker.add.error.timeout' } }
      }

      let convertingMessage
      if (!stickerSet?.boost && total.waiting > 5) {
        convertingMessage = await ctx.replyWithHTML(ctx.i18n.t('sticker.add.converting_process', {
          progress: total.waiting + 1,
          total: total.waiting + 1
        }))
      }

      let frameType = isVideoNote ? 'circle' : 'rounded'
      const forceCrop = inputFile.forceCrop || stickerSet.packType === 'custom_emoji'

      if (frameType === 'rounded') {
        frameType = stickerSet.frameType || 'square'
      }

      try {
        await convertQueue.add({
          input: {
            botId: ctx.botInfo.id,
            userId: ctx.from.id,
            chatId: ctx.chat.id,
            locale: ctx.i18n.locale(),
            showResult,
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
          // Failed jobs carry the base64 fileData; without this they pile up in
          // Redis forever.
          removeOnFail: true
        })
        queued = true
      } catch (err) {
        // The "converting N/N" message would otherwise sit there for good.
        if (convertingMessage) {
          await ctx.telegram.deleteMessage(ctx.chat.id, convertingMessage.message_id).catch(() => {})
        }
        return { error: { i18nKey: 'sticker.add.error.convert' } }
      }

      return { wait: true }
    } finally {
      if (!queued) videoProcessing.delete(ctx.from.id)
    }
  }

  // Static image processing - rate limiting
  const lastTime = lastStickerTime.get(ctx.from.id) || 0

  if (Date.now() - lastTime < STICKER_COOLDOWN && !stickerSet?.boost) {
    return { error: { i18nKey: 'sticker.add.error.wait_load' } }
  }

  // Held for the duration of the processing only, and released in the finally
  // below no matter how we leave. Previously it was cleared solely on the happy
  // path, so a broken file / sharp throw locked the user out for 30 s and the
  // *next* valid file was rejected with "still processing the previous one".
  lastStickerTime.set(ctx.from.id, Date.now())

  try {
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

    const imageSharp = sharp(fileData, {
      failOnError: false,
      limitInputPixels: 268402689,
      pages: 1
    })

    const imageMetadata = await imageSharp.metadata().catch((err) => {
      console.error('Sharp metadata error:', err.message, 'Buffer size:', fileData?.length, 'First bytes:', fileData?.slice(0, 20)?.toString('hex'))
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

    return await uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra, getStickerSetCheck.stickers)
  } finally {
    lastStickerTime.delete(ctx.from.id)
  }
}
