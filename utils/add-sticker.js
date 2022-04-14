const https = require('https')
const sharp = require('sharp')
const Queue = require('bull')
const EventEmitter = require('events')

EventEmitter.defaultMaxListeners = 30

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
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, animatedStickerSet.name, {
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
    if (!stickerSet || (isVideo && !stickerSet.video)) {
      if (isVideo) {
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

    emojis += stickerSet.emojiSuffix || ''

    let fileUrl

    if (stickerFile.fileUrl) {
      fileUrl = stickerFile.fileUrl
    } else {
      fileUrl = await ctx.telegram.getFileLink(stickerFile)
    }

    const stickerExtra = {
      emojis
    }

    if (stickerSet && !stickerSet.video && inputFile.mime_type && inputFile.mime_type.match('video')) {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
        reply_to_message_id: ctx.message.message_id
      })
    }

    if (isVideo) {
      if (!queue[ctx.from.id]) queue[ctx.from.id] = {}
      const userQueue = queue[ctx.from.id]

      if (userQueue.video && !ctx.session.userInfo.premium) {
        return ctx.reply('wait load...')
      }
      userQueue.video = true
      if (inputFile.file_size > 1000 * 1000 * 5 || inputFile.duration >= 35) { // 5 mb or 35 sec
        userQueue.video = false
        return ctx.reply('file too big')
      }

      if (inputFile.is_video) {
        const data = await downloadFileByUrl(fileUrl)

        stickerExtra.webm_sticker = {
          source: data
        }
      } else {
        let priority = 10
        if (ctx.session.userInfo.premium) priority = 9

        const job = await convertQueue.add({ fileUrl }, {
          priority,
          attempts: 1,
          removeOnComplete: true
        })

        const file = await job.finished()

        if (file.metadata) {
          stickerExtra.webm_sticker = {
            source: Buffer.from(file.content, 'base64')
          }
        }
      }
      userQueue.video = false
    } else {
      const data = await downloadFileByUrl(fileUrl)
      const imageSharp = sharp(data)
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
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, stickerSet.name, stickerExtra).catch((error) => {
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
