const https = require('https')
const sharp = require('sharp')

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
  let stickerFile = inputFile

  const originalSticker = await ctx.db.Sticker.findOne({
    fileUniqueId: stickerFile.file_unique_id
  })

  if (originalSticker && originalSticker.file) stickerFile = originalSticker.file

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

  let emojis = inputFile.emoji || ''

  if (ctx.session.userInfo.stickerSet && ctx.session.userInfo.stickerSet.inline) {
    await ctx.db.Sticker.addSticker(ctx.session.userInfo.stickerSet.id, emojis, stickerFile, null)

    return {
      ok: {
        inline: true
      }
    }
  } else if (stickerFile.is_animated !== true) {
    if (!ctx.session.userInfo.stickerSet) ctx.session.userInfo.stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)
    emojis += ctx.session.userInfo.stickerSet.emojiSuffix || ''
    const fileUrl = await ctx.telegram.getFileLink(stickerFile).catch((error) => {
      console.error(error, stickerFile)
    })
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

    const fileBuffer = await imageSharp.webp({ quality: 100 }).png({ force: false }).toBuffer()

    let stickerAdd = false

    if (ctx.session.userInfo.stickerSet.create === false) {
      stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, ctx.session.userInfo.stickerSet.name, ctx.session.userInfo.stickerSet.title, {
        png_sticker: { source: fileBuffer },
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
        ctx.session.userInfo.stickerSet.create = true
        await ctx.session.userInfo.stickerSet.save()
      }
    } else {
      stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, ctx.session.userInfo.stickerSet.name, {
        png_sticker: { source: fileBuffer },
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
      const getStickerSet = await ctx.telegram.getStickerSet(ctx.session.userInfo.stickerSet.name).catch((error) => {
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

      await ctx.db.Sticker.addSticker(ctx.session.userInfo.stickerSet.id, emojis, stickerInfo, stickerFile)

      return {
        ok: {
          title: ctx.session.userInfo.stickerSet.title,
          link: `${ctx.config.stickerLinkPrefix}${ctx.session.userInfo.stickerSet.name}`,
          stickerInfo
        }
      }
    }
  } else {
    if (!ctx.session.userInfo.animatedStickerSet) ctx.session.userInfo.animatedStickerSet = await ctx.db.StickerSet.getSet(defaultAnimatedStickerSet)
    emojis += ctx.session.userInfo.animatedStickerSet.emojiSuffix || ''
    const fileUrl = await ctx.telegram.getFileLink(stickerFile).catch((error) => {
      console.error(error, stickerFile)
    })
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
