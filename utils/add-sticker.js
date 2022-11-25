const fs = require('fs').promises
const https = require('https')
const sharp = require('sharp')
const Queue = require('bull')
const EventEmitter = require('events')

EventEmitter.defaultMaxListeners = 100

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

let queue = {}
setInterval(() => {
  queue = {}
}, 1000 * 30)

module.exports = async (ctx, inputFile, toStickerSet = false) => {
  let stickerFile = inputFile

  const originalSticker = await ctx.db.Sticker.findOne({
    fileUniqueId: stickerFile.file_unique_id
  })

  if (originalSticker && originalSticker.file && originalSticker.file_id) stickerFile = originalSticker.file

  let {
    stickerSet,
    videoStickerSet,
    animatedStickerSet
  } = ctx.session.userInfo

  if (toStickerSet) {
    stickerSet = toStickerSet
  }

  let emojis = inputFile.emoji || ''

  if (stickerSet && stickerSet.inline) {
    const sticker = await ctx.db.Sticker.addSticker(stickerSet.id, emojis, stickerFile, null)

    return {
      ok: {
        inline: true,
        sticker,
        stickerSet
      }
    }
  }

  const isVideo = (stickerSet?.video || inputFile.is_video || (inputFile.mime_type && inputFile.mime_type.match('video'))) || false
  const isVideoNote = (inputFile.video_note) || false

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` :: @${ctx.options.username}`

  const defaultStickerSet = {
    owner: ctx.session.userInfo.id,
    name: `f_${Math.random().toString(36).substring(5)}_${ctx.from.id}`,
    title: 'Favorite stickers',
    emojiSuffix: '🌟'
  }

  defaultStickerSet.name += nameSuffix
  if (ctx.session.userInfo.premium !== true) defaultStickerSet.title += titleSuffix

  if (stickerFile.is_animated === true || stickerSet?.animated) {
    if (!animatedStickerSet) {
      animatedStickerSet = await ctx.db.StickerSet.getSet({
        owner: defaultStickerSet.owner,
        name: defaultStickerSet.name,
        title: 'Animated ' + defaultStickerSet.title,
        animated: true,
        emojiSuffix: defaultStickerSet.emojiSuffix
      })

      ctx.session.userInfo.animatedStickerSet = animatedStickerSet
    }

    emojis += animatedStickerSet.emojiSuffix || ''
    const fileUrl = await ctx.telegram.getFileLink(stickerFile)
    const data = await downloadFileByUrl(fileUrl)

    let stickerAdd = false

    if (animatedStickerSet.create === false) {
      stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, animatedStickerSet.name, animatedStickerSet.title, {
        tgs_sticker: { source: data },
        emojis
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
        if (!animatedStickerSet) {
          animatedStickerSet = stickerSet
          ctx.session.userInfo.animatedStickerSet = stickerSet
        }

        animatedStickerSet.create = true
        await animatedStickerSet.save()
      }
    } else {
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, animatedStickerSet.name.toLowerCase(), {
        tgs_sticker: { source: data },
        emojis
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
      const getStickerSet = await ctx.telegram.getStickerSet(animatedStickerSet.name).catch((error) => {
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

      const sticker = await ctx.db.Sticker.addSticker(animatedStickerSet.id, emojis, stickerInfo, stickerFile)

      return {
        ok: {
          title: animatedStickerSet.title,
          link: `${ctx.config.stickerLinkPrefix}${animatedStickerSet.name}`,
          stickerInfo,
          sticker
        }
      }
    }
  } else {
    if (!stickerSet || (isVideo || isVideoNote && !stickerSet.video)) {
      if (isVideo || isVideoNote) {
        if (videoStickerSet) {
          stickerSet = videoStickerSet
        } else {
          stickerSet = await ctx.db.StickerSet.getSet({
            owner: defaultStickerSet.owner,
            name: defaultStickerSet.name,
            title: 'Video ' + defaultStickerSet.title,
            video: true,
            emojiSuffix: defaultStickerSet.emojiSuffix
          })

          ctx.session.userInfo.videoStickerSet = stickerSet
        }
      } else {
        stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)
      }

      ctx.session.userInfo.stickerSet = stickerSet
    }

    const getStickerSet_check = await ctx.telegram.getStickerSet(stickerSet.name).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })
    if (getStickerSet_check.error) {
      return getStickerSet_check
    }

    emojis += stickerSet.emojiSuffix || ''
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
      const job = await removebgQueue.add({
        fileUrl,
      }, {
        attempts: 1,
        removeOnComplete: true
      })

      const { content } = await job.finished()

      fileData = Buffer.from(content, 'base64')
    }

    const stickerExtra = {
      emojis
    }

    if (stickerSet && !stickerSet.video && inputFile.mime_type && inputFile.mime_type.match('video')) {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
        reply_to_message_id: ctx.message.message_id
      })
    }

    if (isVideo || isVideoNote) {
      if (!queue[ctx.from.id]) queue[ctx.from.id] = {}
      const userQueue = queue[ctx.from.id]

      if (userQueue.video && !ctx.session.userInfo.premium) {
        return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.wait_load'), {
          reply_to_message_id: ctx.message.message_id
        })
      }
      userQueue.video = true
      if (inputFile.file_size > 1000 * 1000 * 10 || inputFile.duration >= 35) { // 10 mb or 35 sec
        userQueue.video = false
        return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.too_big'), {
          reply_to_message_id: ctx.message.message_id
        })
      }

      if (inputFile.is_video || inputFile.skip_reencode) {
        fileData = await downloadFileByUrl(fileUrl)

        stickerExtra.webm_sticker = {
          source: fileData
        }
      } else {
        let priority = 10
        if (ctx.session.userInfo.premium) priority = 5
        if (ctx.i18n.locale() === 'ru') priority = 15

        type = (isVideoNote) ? "circle" : "rounded"
        forceCrop = (inputFile.forceCrop) || false

        if (type === "rounded") {
          type = stickerSet.frameType || "square"
        }

        const job = await convertQueue.add({
          fileUrl,
          fileData: fileData ? Buffer.from(fileData).toString('base64') : null,
          timestamp: Date.now(),
          type,
          forceCrop
        }, {
          priority,
          attempts: 1,
          removeOnComplete: true
        })

        const total = await convertQueue.getJobCounts()

        const waitMessage = await ctx.replyWithHTML('⏳')

        if (!ctx.session.userInfo.premium && total.waiting > 3) {
          const convertingMessage = await ctx.replyWithHTML(ctx.i18n.t('sticker.add.converting_process', {
            progress: total.waiting,
            total: total.waiting
          }))

          const updateMessage = setInterval(async () => {
            const waiting = await convertQueue.getWaiting()

            const progress = waiting.findIndex((item) => {
              return item.id === job.id
            })

            const total = await convertQueue.getJobCounts()

            ctx.telegram.editMessageText(ctx.from.id, convertingMessage.message_id, null, ctx.i18n.t('sticker.add.converting_process', {
              progress: progress + 1,
              total: total.waiting
            }), {
              parse_mode: 'HTML'
            }).catch(() => {})

            if (progress <= 0) {
              clearInterval(updateMessage)
              ctx.tg.deleteMessage(ctx.from.id, convertingMessage.message_id)
            }
          }, 1000 * 5)
        }

        const file = await Promise.race([job.finished().catch(error => {
          return {
            error: {
              convertQueue: error
            }
          }
        }), new Promise(resolve => {
          setTimeout(() => {
            resolve({
              error: {
                convertQueue: 'timeout'
              }
            })
          }, 1000 * 60 * 15)
        })])

        if (file.error) {
          try {
            clearInterval(updateMessage)
            ctx.tg.deleteMessage(ctx.from.id, convertingMessage.message_id)
          } catch (error) {
          }

          if (file.error.convertQueue === 'timeout') {
            return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.timeout'), {
              reply_to_message_id: ctx.message.message_id
            })
          }

          return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.convert'), {
            reply_to_message_id: ctx.message.message_id
          })
        }

        ctx.tg.deleteMessage(ctx.from.id, waitMessage.message_id)


        if (file.metadata) {
          stickerExtra.webm_sticker = {
            source: Buffer.from(file.content, 'base64')
          }
        }
      }
      userQueue.video = false
    } else {
      if (!fileData) {
        fileData = await downloadFileByUrl(fileUrl)
      }

      const imageSharp = sharp(fileData)
      const imageMetadata = await imageSharp.metadata().catch(() => { })

      if (
        imageMetadata.width > 512 || imageMetadata.height > 512 ||
        (imageMetadata.width !== 512 && imageMetadata.height !== 512)
      ) {
        if (imageMetadata.height > imageMetadata.width) imageSharp.resize({ height: 512 })
        else imageSharp.resize({ width: 512 })
      }

      stickerExtra.png_sticker = {
        source: await imageSharp.webp({ quality: 100 }).png({ force: false }).toBuffer()
      }
    }

    let stickerAdd = false

    if (stickerSet.create === false) {
      stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, stickerSet.name, stickerSet.title, stickerExtra).catch((error) => {
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
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, stickerSet.name.toLowerCase(), stickerExtra).catch((error) => {
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
      const getStickerSet = await ctx.telegram.getStickerSet(stickerSet.name).catch((error) => {
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

      const sticker = await ctx.db.Sticker.addSticker(stickerSet.id, emojis, stickerInfo, stickerFile)

      return {
        ok: {
          title: stickerSet.title,
          link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
          stickerInfo,
          sticker
        }
      }
    }
  }
}
