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

let queue = {}
setInterval(() => {
  queue = {}
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

  delete queue[input.chatId]

  const stickerExtra = input.stickerExtra

  if (metadata) {
    stickerExtra.sticker = {
      source: Buffer.from(content, 'base64')
    }
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

  const { input, metadata, content } = job.data

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

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

const downloadFileByUrl = (fileUrl) => new Promise((resolve, reject) => {
  const data = []

  https.get(fileUrl, (response) => {
    response.on('data', (chunk) => {
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(Buffer.concat(data))
    })
  }).on('error', reject)
})

const uploadSticker = async (userId, stickerSet, stickerFile, stickerExtra) => {
  let stickerAdd

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

  if (stickerSet.create === false) {
    stickerAdd = await telegram.createNewStickerSet(userId, stickerSet.name, stickerSet.title, stickerExtra).catch((error) => {
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

  if (originalSticker && originalSticker.file && originalSticker.file_id) stickerFile = originalSticker.file

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

  const isVideo = inputFile.is_video || !!(inputFile.mime_type && inputFile.mime_type.match('video')) || inputFile.mime_type === 'image/gif' || inputFile.duration > 0 || false
  const isVideoNote = (inputFile.video_note) || false

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
  } else if (stickerFile.is_video || isVideo || isVideoNote) {
    stickerExtra.sticker_format = 'video'
  } else {
    stickerExtra.sticker_format = 'static'
  }

  if (stickerFile.is_animated) {
    // stickerExtra.sticker_format = 'animated'

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
      if (!queue[ctx.from.id]) queue[ctx.from.id] = {}
      const userQueue = queue[ctx.from.id]

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

        const imageSharp = sharp(fileData, { failOnError: false })
        const imageMetadata = await imageSharp.metadata().catch(() => {})

        if (!imageMetadata) {
          throw new Error('Invalid image')
        }

        if (stickerSet.packType === 'custom_emoji') {
          if (imageMetadata.width !== 100 || imageMetadata.height !== 100) {
            imageSharp.resize({ width: 100, height: 100 })
          }
        } else {
          if (
            imageMetadata.width > 512 || imageMetadata.height > 512 ||
            (imageMetadata.width !== 512 && imageMetadata.height !== 512)
          ) {
            if (imageMetadata.height > imageMetadata.width) imageSharp.resize({ height: 512 })
            else imageSharp.resize({ width: 512 })
          }
        }

        stickerExtra.sticker = {
          source: await imageSharp.webp({ quality: 100 }).png({ force: false }).toBuffer()
        }
      }
    }
  }

  if (lastStickerTime[ctx.from.id]) {
    delete lastStickerTime[ctx.from.id]
  }

  return uploadSticker(ctx.from.id, stickerSet, stickerFile, stickerExtra)
}
