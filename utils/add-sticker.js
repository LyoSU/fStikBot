const fs = require('fs')
const https = require('https')
const Stream = require('stream').Transform
const sharp = require('sharp')
const hasha = require('hasha')


const downloadFileByUrl = (fileUrl) => new Promise(async (resolve, reject) => {
  const data = new Stream()

  https.get(fileUrl, (response) => {
    response.on('data', (chunk) => {
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(data)
    })
  }).on('error', reject)
})

module.exports = (ctx, inputFile) => new Promise(async (resolve) => {
  let stickerFile = inputFile

  const originalSticker = await ctx.db.Sticker.findOne({
    'info.file_id': stickerFile.file_id,
  })

  if (originalSticker && originalSticker.file) stickerFile = originalSticker.file

  if (!ctx.db.user) ctx.db.user = await ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate('stickerSet')
  if (!ctx.db.stickerSet) ctx.db.stickerSet = await ctx.db.User.findById(ctx.db.user.stickerSet)

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` by @${ctx.options.username}`

  const defaultStickerSet = {
    owner: ctx.db.user.id,
    name: `${Math.random().toString(36).substring(5)}_${ctx.from.id}`,
    title: 'Favorite stickers',
    emojiSuffix: '🌟',
  }

  defaultStickerSet.name += nameSuffix
  if (ctx.db.user.premium !== true) defaultStickerSet.title += titleSuffix

  if (!ctx.db.stickerSet) ctx.db.stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)

  let emojis = inputFile.emoji || ''

  emojis += ctx.db.stickerSet.emojiSuffix || ''

  const fileUrl = await ctx.telegram.getFileLink(stickerFile)
  const data = await downloadFileByUrl(fileUrl)
  const imageSharp = sharp(data.read())
  const imageMetadata = await imageSharp.metadata()

  if (imageMetadata.height >= imageMetadata.width) imageSharp.resize({ height: 512 })
  else imageSharp.resize({ width: 512 })

  const tmpPath = `tmp/${stickerFile.file_id}_${Date.now()}.png`

  await imageSharp.webp({ quality: 100 }).png({ compressionLevel: 9, force: false }).toFile(tmpPath)

  const hash = await hasha.fromFile(tmpPath, { algorithm: 'md5' })
  let stickerAdd = false

  if (ctx.db.stickerSet.create === false) {
    // eslint-disable-next-line max-len
    stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, ctx.db.stickerSet.name, ctx.db.stickerSet.title, {
      png_sticker: { source: tmpPath },
      emojis,
    }).catch((error) => {
      resolve({
        error: {
          telegram: error,
        },
      })
    })

    if (stickerAdd) {
      ctx.db.stickerSet.create = true
      ctx.db.stickerSet.save()
      ctx.db.user.stickerSet = ctx.db.stickerSet.id
      ctx.db.user.save()
    }
  }
  else {
    stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, ctx.db.stickerSet.name, {
      png_sticker: { source: tmpPath },
      emojis,
    }).catch((error) => {
      resolve({
        error: {
          telegram: error,
        },
      })
    })
  }

  if (stickerAdd) {
    const getStickerSet = await ctx.telegram.getStickerSet(ctx.db.stickerSet.name)
    const stickerInfo = getStickerSet.stickers.slice(-1)[0]

    ctx.db.Sticker.addSticker(ctx.db.stickerSet.id, emojis, hash, stickerInfo, stickerFile).catch((error) => {
      resolve({
        error: {
          telegram: error,
        },
      })
    })

    resolve({
      ok: {
        title: ctx.db.stickerSet.title,
        link: `${ctx.config.stickerLinkPrefix}${ctx.db.stickerSet.name}`,
        stickerInfo,
      },
    })
  }

  fs.unlink(tmpPath, (err) => {
    if (err) throw err
  })
})
