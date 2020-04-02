const fs = require('fs')
const https = require('https')
const sharp = require('sharp')
const hasha = require('hasha')

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

module.exports = async (ctx, inputFile) => {
  let tmpPath = `tmp/${inputFile.file_id}_${Date.now()}`

  const result = await (async () => {
    let stickerFile = inputFile

    const originalSticker = await ctx.db.Sticker.findOne({
      fileUniqueId: stickerFile.file_unique_id
    })

    if (originalSticker && originalSticker.file) stickerFile = originalSticker.file

    if (!ctx.session.user) ctx.session.user = await ctx.db.User.getData(ctx.from)

    const nameSuffix = `_by_${ctx.options.username}`
    const titleSuffix = ` by @${ctx.options.username}`

    const defaultStickerSet = {
      owner: ctx.session.user.id,
      name: `f_${Math.random().toString(36).substring(5)}_${ctx.from.id}`,
      title: 'Favorite stickers',
      emojiSuffix: '🌟'
    }

    defaultStickerSet.name += nameSuffix
    if (ctx.session.user.premium !== true) defaultStickerSet.title += titleSuffix
    if (!ctx.session.user.stickerSet) ctx.session.user.stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)

    let emojis = inputFile.emoji || ''

    emojis += ctx.session.user.stickerSet.emojiSuffix || ''

    if (stickerFile.is_animated !== true) {
      const fileUrl = await ctx.telegram.getFileLink(stickerFile)
      const data = await downloadFileByUrl(fileUrl)
      const imageSharp = sharp(data)
      const imageMetadata = await imageSharp.metadata().catch(() => {})

      if (
        imageMetadata.width > 512 || imageMetadata.height > 512 ||
        (imageMetadata.width !== 512 && imageMetadata.height !== 512)
      ) {
        if (imageMetadata.height > imageMetadata.width) imageSharp.resize({ height: 512 })
        else imageSharp.resize({ width: 512 })
      }

      await imageSharp.webp({ quality: 100 }).png({ force: false }).toFile(tmpPath).catch(() => {})

      const hash = await hasha.fromFile(tmpPath, { algorithm: 'md5' })

      let stickerAdd = false

      if (ctx.session.user.stickerSet.create === false) {
        stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, ctx.session.user.stickerSet.name, ctx.session.user.stickerSet.title, {
          png_sticker: { source: tmpPath },
          emojis
        }).catch((error) => {
          return {
            error: {
              telegram: error
            }
          }
        })

        if (stickerAdd) {
          ctx.session.user.stickerSet.create = true
          ctx.session.user.stickerSet.save()
          ctx.session.user.save()
        }
      } else {
        stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, ctx.session.user.stickerSet.name, {
          png_sticker: { source: tmpPath },
          emojis
        }).catch((error) => {
          return {
            error: {
              telegram: error
            }
          }
        })
      }

      if (stickerAdd) {
        const getStickerSet = await ctx.telegram.getStickerSet(ctx.session.user.stickerSet.name)
        const stickerInfo = getStickerSet.stickers.slice(-1)[0]

        ctx.db.Sticker.addSticker(ctx.session.user.stickerSet.id, emojis, hash, stickerInfo, stickerFile).catch((error) => {
          return {
            error: {
              telegram: error
            }
          }
        })

        return {
          ok: {
            title: ctx.session.user.stickerSet.title,
            link: `${ctx.config.stickerLinkPrefix}${ctx.session.user.stickerSet.name}`,
            stickerInfo
          }
        }
      }
    } else {
      tmpPath = false
      const fileUrl = await ctx.telegram.getFileLink(stickerFile)
      const data = await downloadFileByUrl(fileUrl)

      const hash = hasha(data, { algorithm: 'md5' })

      let animatedStickerSet = await ctx.db.StickerSet.findOne({
        owner: ctx.session.user.id,
        animated: true,
        create: true,
        hide: false
      })

      let stickerAdd = false

      if (!animatedStickerSet) {
        animatedStickerSet = new ctx.db.StickerSet()

        animatedStickerSet.owner = defaultStickerSet.owner
        animatedStickerSet.name = defaultStickerSet.name
        animatedStickerSet.title = 'Animated ' + defaultStickerSet.title
        animatedStickerSet.animated = true
        animatedStickerSet.emojiSuffix = defaultStickerSet.emojiSuffix
        animatedStickerSet.create = false

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

        if (stickerAdd) {
          animatedStickerSet.create = true
          animatedStickerSet.save()
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
      }

      if (stickerAdd) {
        const getStickerSet = await ctx.telegram.getStickerSet(animatedStickerSet.name)
        const stickerInfo = getStickerSet.stickers.slice(-1)[0]

        ctx.db.Sticker.addSticker(animatedStickerSet.id, emojis, hash, stickerInfo, stickerFile).catch((error) => {
          return {
            error: {
              telegram: error
            }
          }
        })

        return {
          ok: {
            title: animatedStickerSet.title,
            link: `${ctx.config.stickerLinkPrefix}${animatedStickerSet.name}`,
            stickerInfo
          }
        }
      }
    }
  })()

  try {
    if (tmpPath) fs.unlinkSync(tmpPath)
  } catch (error) {
    console.error(error)
  }

  return result
}
