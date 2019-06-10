const fs = require('fs')
const https = require('https')
const Stream = require('stream').Transform
const sharp = require('sharp')
const hasha = require('hasha')


module.exports = async (ctx) => {
  let fileId

  const emojiSufix = '🌟'

  const stickerSet = {
    name: `test_by_${ctx.options.username}`,
    emojis: '',
  }

  ctx.replyWithChatAction('upload_document')

  switch (ctx.updateSubTypes[0]) {
    case 'sticker':
      stickerSet.emojis += ctx.message.sticker.emoji
      fileId = ctx.message.sticker.file_id
      break

    case 'document':
      if (ctx.message.documentmime_type === ['image/jpeg']) {
        fileId = ctx.message.document.file_id
      }
      break

    case 'photo':
      fileId = ctx.message.photo.slice(-1)[0].file_id
      break

    default:
      console.log(ctx.updateSubTypes)
  }

  if (fileId) {
    const fileUrl = await ctx.telegram.getFileLink(fileId)

    https.get(fileUrl, (response) => {
      const data = new Stream()

      response.on('data', (chunk) => {
        data.push(chunk)
      })

      response.on('end', async () => {
        console.log(fileId)
        const tmpPath = `tmp/${fileId}.png`
        const sharpImage = sharp(data.read())

        await sharpImage.png().toFile(tmpPath)

        const hash = await hasha.fromFile(tmpPath, { algorithm: 'md5' })

        ctx.db.Sticker.addSticker()

        const emojis = stickerSet.emojis + emojiSufix

        const createNewStickerSet = await ctx.telegram.createNewStickerSet(ctx.from.id, stickerSet.name, 'test', {
          png_sticker: { source: tmpPath },
          emojis,
        }).catch(() => {})

        if (!createNewStickerSet) {
          await ctx.telegram.addStickerToSet(ctx.from.id, stickerSet.name, {
            png_sticker: { source: tmpPath },
            emojis,
          }).catch(() => {})
        }

        ctx.replyWithHTML(`http://t.me/addstickers/${stickerSet.name}`, {
          reply_to_message_id: ctx.message.message_id,
        })

        fs.unlink(tmpPath, (err) => {
          if (err) throw err
        })
      })
    })
  }
  else {
    ctx.replyWithHTML('error', {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
