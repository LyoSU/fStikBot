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

module.exports = (ctx, file) => new Promise(async (resolve) => {
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate('stickerSet')

  let { stickerSet } = user

  const titleSufix = ` by @${ctx.options.username}`
  const nameSufix = `_by_${ctx.options.username}`

  const defaultStickerSet = {
    owner: user.id,
    name: `favorite_${ctx.from.id}`,
    title: 'Favorite stickers',
    emojiSufix: '🌟',
  }

  let emojis = ''

  if (ctx.message.sticker) emojis = ctx.message.sticker.emoji || ''
  emojis += stickerSet.emojiSufix || ''

  defaultStickerSet.title += titleSufix
  defaultStickerSet.name += nameSufix

  if (!stickerSet) stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)

  const fileUrl = await ctx.telegram.getFileLink(file)
  const data = await downloadFileByUrl(fileUrl)

  const tmpPath = `tmp/${file.file_id}_${Date.now()}.png`
  const imageSharp = sharp(data.read())

  const imageMetadata = await imageSharp.metadata()

  if (imageMetadata.height >= imageMetadata.width) imageSharp.resize({ height: 512 })
  else imageSharp.resize({ width: 512 })

  await imageSharp.webp({ quality: 100 }).png({ compressionLevel: 9, force: false }).toFile(tmpPath)

  const hash = await hasha.fromFile(tmpPath, { algorithm: 'md5' })

  let stickerAdd = false

  if (stickerSet.create === false) {
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
    ctx.db.Sticker.addSticker(stickerSet.id, emojis, hash, stickerInfo, file)
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
