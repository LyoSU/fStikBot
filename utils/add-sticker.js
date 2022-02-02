const https = require('https')
const sharp = require('sharp')
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp')
const { writeFileSync } = require('fs')

function convertToWebmSticker (input) {
  const output = temp.path({ suffix: '.webm' })

  return new Promise((resolve, reject) => {
    const process = ffmpeg()
      .input(input)
      .on('error', (error) => {
        reject(error)
      })
      .on('end', () => {
        ffmpeg.ffprobe(output, (_err, metadata) => {
          resolve({
            output,
            metadata
          })
        })
      })
      .addInputOptions(['-t 3'])
      .output(output)
      .outputOptions(
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
        '-b:v', '500k',
        '-an'
      )
      .duration(2.9)

    process.run()
  })
}

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

module.exports = async (ctx, inputFile) => {
  let stickerFile = inputFile
  let { stickerSet } = ctx.session.userInfo

  const originalSticker = await ctx.db.Sticker.findOne({
    fileUniqueId: stickerFile.file_unique_id
  })

  if (originalSticker && originalSticker.file && originalSticker.file_id) stickerFile = originalSticker.file

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

  const defaultAnimatedStickerSet = {
    owner: defaultStickerSet.owner,
    name: defaultStickerSet.name,
    title: 'Animated ' + defaultStickerSet.title,
    animated: true,
    emojiSuffix: defaultStickerSet.emojiSuffix
  }

  const defaultVideoStickerSet = {
    owner: defaultStickerSet.owner,
    name: defaultStickerSet.name,
    title: 'Video ' + defaultStickerSet.title,
    video: true,
    emojiSuffix: defaultStickerSet.emojiSuffix
  }

  let emojis = inputFile.emoji || ''

  if (stickerSet && stickerSet.inline) {
    await ctx.db.Sticker.addSticker(stickerSet.id, emojis, stickerFile, null)

    return {
      ok: {
        inline: true
      }
    }
  } else if (stickerFile.is_animated !== true) {
    if (!stickerSet) {
      if (inputFile.mime_type && inputFile.mime_type.match('video')) stickerSet = await ctx.db.StickerSet.getSet(defaultVideoStickerSet)
      else stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)
      ctx.session.userInfo = stickerSet
    }
    emojis += stickerSet.emojiSuffix || ''
    const fileUrl = await ctx.telegram.getFileLink(stickerFile)

    const stickerExtra = {
      emojis
    }

    if (stickerSet && !stickerSet.video && inputFile.mime_type && inputFile.mime_type.match('video')) {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
        reply_to_message_id: ctx.message.message_id
      })
    }

    if (stickerSet.video || (inputFile.mime_type && inputFile.mime_type.match('video'))) {
      if (!queue[ctx.from.id]) queue[ctx.from.id] = {}
      const userQueue = queue[ctx.from.id]

      if (userQueue.video) {
        return ctx.reply('wait load...')
      }
      userQueue.video = true
      if (inputFile.file_size > 1000 * 1000 * 2 || inputFile.duration >= 35) { // 3 mb or 60 sec
        userQueue.video = false
        return ctx.reply('file too big')
      }

      if (inputFile.is_video) {
        const data = await downloadFileByUrl(fileUrl)

        stickerExtra.webm_sticker = {
          source: data
        }
      } else {
        const file = await convertToWebmSticker(fileUrl)

        if (!file.metadata) {
          const data = await downloadFileByUrl(fileUrl)

          const input = temp.path({ suffix: '.mp4' })

          writeFileSync(input, data)

          const file = await convertToWebmSticker(fileUrl)

          stickerExtra.webm_sticker = {
            source: file.output
          }
        } else {
          stickerExtra.webm_sticker = {
            source: file.output
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

      await ctx.db.Sticker.addSticker(stickerSet.id, emojis, stickerInfo, stickerFile)

      return {
        ok: {
          title: stickerSet.title,
          link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
          stickerInfo
        }
      }
    }
  } else {
    if (!ctx.session.userInfo.animatedStickerSet) ctx.session.userInfo.animatedStickerSet = await ctx.db.StickerSet.getSet(defaultAnimatedStickerSet)
    emojis += ctx.session.userInfo.animatedStickerSet.emojiSuffix || ''
    const fileUrl = await ctx.telegram.getFileLink(stickerFile)
    const data = await downloadFileByUrl(fileUrl)

    let stickerAdd = false

    if (ctx.session.userInfo.animatedStickerSet.create === false) {
      stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, ctx.session.userInfo.animatedStickerSet.name, ctx.session.userInfo.animatedStickerSet.title, {
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
        ctx.session.userInfo.animatedStickerSet.create = true
        await ctx.session.userInfo.animatedStickerSet.save()
      }
    } else {
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, ctx.session.userInfo.animatedStickerSet.name, {
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
      const getStickerSet = await ctx.telegram.getStickerSet(ctx.session.userInfo.animatedStickerSet.name).catch((error) => {
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

      ctx.db.Sticker.addSticker(ctx.session.userInfo.animatedStickerSet.id, emojis, stickerInfo, stickerFile)

      return {
        ok: {
          title: ctx.session.userInfo.animatedStickerSet.title,
          link: `${ctx.config.stickerLinkPrefix}${ctx.session.userInfo.animatedStickerSet.name}`,
          stickerInfo
        }
      }
    }
  }
}
