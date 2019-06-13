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
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate('stickerSet')
  const originalSticker = await ctx.db.Sticker.findOne({
    'info.file_id': stickerFile.file_id,
  })

  if (originalSticker && originalSticker.file) stickerFile = originalSticker.file

  let { stickerSet } = user

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` by @${ctx.options.username}`

  const defaultStickerSet = {
    owner: user.id,
    name: `favorite_${ctx.from.id}`,
    title: 'Favorite stickers',
    emojiSuffix: '🌟',
  }

  let emojis = ''

  if (ctx.message.sticker) emojis = ctx.message.sticker.emoji || ''
  emojis += stickerSet.emojiSuffix || ''

  defaultStickerSet.name += nameSuffix
  if (user.premium !== true) defaultStickerSet.title += titleSuffix

  if (!stickerSet) stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)

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

  if (stickerSet.create === false) {
    // eslint-disable-next-line max-len
    stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, stickerSet.name, stickerSet.title, {
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
      stickerSet.create = true
      stickerSet.save()
      user.stickerSet = stickerSet.id
      user.save()
    }
  }
  else {
    stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, stickerSet.name, {
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

  const getStickerSet = await ctx.telegram.getStickerSet(stickerSet.name)
  const stickerInfo = getStickerSet.stickers.slice(-1)[0]

  if (stickerAdd) {
    ctx.db.Sticker.addSticker(stickerSet.id, emojis, hash, stickerInfo, stickerFile)
    resolve({
      ok: {
        title: stickerSet.title,
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
      },
    })
  }

  fs.unlink(tmpPath, (err) => {
    if (err) throw err
  })
})
