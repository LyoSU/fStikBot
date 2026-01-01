const path = require('path')
const https = require('https')
const sharp = require('sharp')
const Queue = require('bull')
const EventEmitter = require('events')
const Telegram = require('telegraf/telegram')
const I18n = require('telegraf-i18n')
const emojiRegex = require('emoji-regex')
const { db } = require('../database')
const config = require('../config.json')
const addStickerText = require('../utils/add-sticker-text')

EventEmitter.defaultMaxListeners = 100

// Queue with TTL-based cleanup instead of full reset
const queue = new Map()
const QUEUE_TTL = 1000 * 60 * 5 // 5 minutes TTL

setInterval(() => {
  const now = Date.now()
  for (const [key, value] of queue) {
    if (now - value.timestamp > QUEUE_TTL) {
      queue.delete(key)
    }
  }
}, 1000 * 30)

const telegram = new Telegram(process.env.BOT_TOKEN)
let botInfo = null
telegram.getMe().then((info) => {
  botInfo = info
})

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'uk',
  defaultLanguageOnMissing: true
})

const redisConfig =  {
  port: process.env.REDIS_PORT,
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD
}

const removebgQueue = new Queue('removebg', {
  redis: redisConfig
})

const convertQueue = new Queue('convert', {
  redis: { port: process.env.REDIS_PORT, host: process.env.REDIS_HOST, password: process.env.REDIS_PASSWORD }
})

async function updateConvertQueueMessages () {
  const jobs = await convertQueue.getJobs()
  const waiting = (await convertQueue.getWaiting()).map((job) => job.id)

  for (const job of jobs) {
    if (job?.data?.input?.convertingMessageId) {
      const { input, metadata, content, error } = job.data

      const progress = waiting.findIndex((id) => id === job.id)

      await telegram.editMessageText(input.chatId, input.convertingMessageId, null, i18n.t(input.locale || 'en', 'sticker.add.converting_process', {
        progress: progress + 1,
        total: jobs.length
      }), {
        parse_mode: 'HTML'
      }).catch(() => {})
    }

    if (job?.failedReason) {
      job.remove()
    }
  }

  setTimeout(updateConvertQueueMessages, 1000)
}

updateConvertQueueMessages()

convertQueue.on('global:completed', async (jobId, result) => {
  const { input, metadata, content } = JSON.parse(result)

  queue.delete(input.chatId)

  const stickerExtra = input.stickerExtra

  // Handle case when conversion failed (no metadata/content)
  if (!metadata || !content) {
    if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

    if (input?.botId === botInfo?.id) {
      await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), {
        parse_mode: 'HTML'
      }).catch(() => {})
    }
    return
  }

  stickerExtra.sticker = {
    source: Buffer.from(content, 'base64')
  }

  const uploadResult = await uploadSticker(input.userId, input.stickerSet, input.stickerFile, stickerExtra)

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

  if (input.showResult && input?.botId === botInfo.id) {
    const textResult = addStickerText(uploadResult, input.locale || 'en')

    if (textResult.messageText) {
      await telegram.sendMessage(input.chatId, textResult.messageText, {
        parse_mode: 'HTML',
        reply_markup: textResult.replyMarkup
      })
    }
  }
})

convertQueue.on('global:failed', async (jobId, errorData) => {
  const job = await convertQueue.getJob(jobId)
  if (!job) return

  const { input, metadata, content } = job.data

  // Clean up queue on failure
  if (input?.chatId) queue.delete(input.chatId)

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

  if (errorData === 'timeout') {
    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.timeout'), {
      parse_mode: 'HTML'
    })
  } else {
    await telegram.sendMessage(config.logChatId, `<b>Convert error</b>\n\n<code>${JSON.stringify(errorData)}</code>`, {
      parse_mode: 'HTML'
    })

    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), {
      parse_mode: 'HTML'
    })
  }

  job.remove()
})

const downloadFileByUrl = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  const MAX_SIZE = 20 * 1024 * 1024 // 20MB limit

  const req = https.get(fileUrl, (response) => {
    // Check for successful response status
    if (response.statusCode !== 200) {
      req.destroy()
      reject(new Error(`Download failed with status ${response.statusCode}`))
      return
    }

    response.on('data', (chunk) => {
      totalSize += chunk.length
      if (totalSize > MAX_SIZE) {
        req.destroy()
        reject(new Error('File too large'))
        return
      }
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(Buffer.concat(data))
    })
  })

  req.on('error', reject)

  req.setTimeout(timeout, () => {
    req.destroy()
    reject(new Error('Download timeout'))
  })
})

const uploadSticker = async (userId, stickerSet, stickerFile, stickerExtra) => {
  let stickerAdd

  // Validate stickerExtra has required fields
  if (!stickerExtra || !stickerExtra.sticker) {
    return {
      error: {
        message: 'Invalid sticker data: sticker is undefined'
      }
    }
  }

  let { sticker } = stickerExtra

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
        emoji_list: stickerExtra.emojis,
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

    const stickerInfo = getStickerSet.stickers.slice(-1)[0]

    const sticker = await db.Sticker.addSticker(stickerSet._id, stickerExtra.emojis, stickerInfo, stickerFile)

    const linkPrefix = stickerSet.packType === 'custom_emoji' ? config.emojiLinkPrefix : config.stickerLinkPrefix

    return {
      ok: {
        title: stickerSet.title,
        link: `${linkPrefix}${stickerSet.name}`,
        stickerInfo,
        sticker
      }
    }
  }
}

const lastStickerTime = {}

module.exports = async (ctx, inputFile, toStickerSet, showResult = true) => {
  let stickerFile = inputFile

  const originalSticker = await ctx.db.Sticker.findOne({
    fileUniqueId: stickerFile.file_unique_id
  })

  // Use original file if available (supports both new and legacy schema)
  // This preserves the chain: Pack A → Pack B → Pack C all point to original source
  if (originalSticker && originalSticker.hasOriginal()) {
    stickerFile = {
      file_id: originalSticker.getOriginalFileId(),
      file_unique_id: originalSticker.getOriginalFileUniqueId(),
      stickerType: originalSticker.getOriginalStickerType() || stickerFile.stickerType
    }
  }

  const stickerSet = toStickerSet

  if (stickerSet && stickerSet.inline) {
    const sticker = await ctx.db.Sticker.addSticker(stickerSet.id, inputFile.emoji, stickerFile, null)

    return {
      ok: {
        inline: true,
        sticker,
        stickerSet
      }
    }
  }

  let emojis = []

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

  // Unified video detection - check all possible sources
  const stickerType = stickerFile.stickerType
  const isVideo =
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

    fileData = await downloadFileByUrl(fileUrl)
    stickerExtra.sticker = {
      source: fileData,
      sticker_format: 'animated'
    }
  } else {
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

    if (inputFile.removeBg) {
      let priority = 10
      if (stickerSet?.boost) priority = 5
      else if (ctx.i18n.locale() === 'ru') priority = 15

      const job = await removebgQueue.add({
        fileUrl,
      }, {
        priority,
        attempts: 1,
        removeOnComplete: true
      })

      const { content } = await job.finished()

      const trimBuffer = await sharp(Buffer.from(content, 'base64'))
        .trim()
        .toBuffer()

      fileData = trimBuffer
    }

    if (
      isVideo || isVideoNote
      || (stickerExtra.sticker_format === 'static' && stickerSet.frameType && stickerSet.frameType !== 'square')
    ) {
      if (!queue.has(ctx.from.id)) queue.set(ctx.from.id, { timestamp: Date.now(), video: false })
      const userQueue = queue.get(ctx.from.id)

      if (userQueue.video && !stickerSet?.boost) {
        return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.wait_load'), {
          reply_to_message_id: ctx?.message?.message_id,
          allow_sending_without_reply: true
        })
      }
      userQueue.video = true
      if (inputFile.file_size > 1000 * 1000 * 15 || inputFile.duration > 65) { // 15 mb or 65 sec
        userQueue.video = false
        return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.too_big'), {
          reply_to_message_id: ctx?.message?.message_id,
          allow_sending_without_reply: true
        })
      }

      if ((inputFile.is_video && inputFile.type === stickerSet.packType) || inputFile.skip_reencode) {
        stickerExtra.sticker = {
          source: await downloadFileByUrl(fileUrl)
        }
      } else {
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

        const maxDuration = (stickerSet?.boost) ? 35 : 4

        const total = await convertQueue.getJobCounts()

        if (total.waiting > 200 && priority > 50) {
          return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.timeout'), {
            reply_to_message_id: ctx?.message?.message_id,
            allow_sending_without_reply: true
          })
        }

        let convertingMessage

        if (!stickerSet?.boost && total.waiting > 5) {
          convertingMessage = await ctx.replyWithHTML(ctx.i18n.t('sticker.add.converting_process', {
            progress: total.waiting + 1,
            total: total.waiting + 1
          }))
        }

        let frameType = (isVideoNote) ? "circle" : "rounded"
        forceCrop = (inputFile.forceCrop || stickerSet.packType === 'custom_emoji') ? true : false

        if (frameType === "rounded") {
          frameType = stickerSet.frameType || "square"
        }

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
            stickerFile,
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
          removeOnComplete: true
        })

        return {
          wait: true
        }
      }
      userQueue.video = false
    } else {
      if (!fileData) {
        fileData = await downloadFileByUrl(fileUrl)
      }

      if (stickerFile.set_name && stickerFile.type === stickerSet.packType) {
        stickerExtra.sticker = stickerFile.file_id

        return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra)
      } else {
        const currentTime = Date.now();
        const lastTime = lastStickerTime[ctx.from.id] || 0;

        if (
          currentTime - lastTime < 1000 * 30
          && !stickerSet?.boost
        ) {
          return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.wait_load'), {
            reply_to_message_id: ctx?.message?.message_id,
            allow_sending_without_reply: true
          })
        }

        lastStickerTime[ctx.from.id] = currentTime

        setTimeout(() => {
          delete lastStickerTime[ctx.from.id]
        }, 1000 * 30);

        const imageSharp = sharp(fileData, {
          failOnError: false,
          limitInputPixels: 268402689, // ~500MB pixel buffer limit
          pages: 1 // only first page for multi-page formats
        })
        const imageMetadata = await imageSharp.metadata().catch((err) => {
          console.error('Sharp metadata error:', err.message, 'Buffer size:', fileData?.length)
          return null
        })

        if (!imageMetadata) {
          throw new Error('Invalid image: unable to read metadata')
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
          // Calculate final dimensions after resize
          let finalWidth = imageMetadata.width
          let finalHeight = imageMetadata.height

          // For regular stickers, resize if larger than 512
          if (imageMetadata.width > 512 || imageMetadata.height > 512) {
            const scale = Math.min(512 / imageMetadata.width, 512 / imageMetadata.height)
            finalWidth = Math.round(imageMetadata.width * scale)
            finalHeight = Math.round(imageMetadata.height * scale)

            pipeline = pipeline.resize(512, 512, {
              fit: 'inside',
              withoutEnlargement: true
            })
          }

          // Only add padding if neither side is 512 (one side must be exactly 512)
          if (finalWidth < 512 && finalHeight < 512) {
            // Pad the larger dimension to 512
            if (finalWidth >= finalHeight) {
              // Landscape or square - pad width
              const paddingLeft = Math.floor((512 - finalWidth) / 2)
              const paddingRight = Math.ceil((512 - finalWidth) / 2)
              pipeline = pipeline.extend({
                left: paddingLeft,
                right: paddingRight,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
              })
            } else {
              // Portrait - pad height
              const paddingTop = Math.floor((512 - finalHeight) / 2)
              const paddingBottom = Math.ceil((512 - finalHeight) / 2)
              pipeline = pipeline.extend({
                top: paddingTop,
                bottom: paddingBottom,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
              })
            }
          }
        }

        stickerExtra.sticker = {
          source: await pipeline.png({ compressionLevel: 6, effort: 3 }).toBuffer()
        }
      }
    }
  }

  if (lastStickerTime[ctx.from.id]) {
    delete lastStickerTime[ctx.from.id]
  }

  return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra)
}
