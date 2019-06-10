const fs = require('fs')
const https = require('https')
const Stream = require('stream').Transform
const sharp = require('sharp')
const hasha = require('hasha')


module.exports = async (ctx) => {
  ctx.replyWithChatAction('upload_document')

  const stickerLinkPrefix = 't.me/addstickers/'
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })

  const titleSufix = ` via @${ctx.options.username}`
  const nameSufix = `_by_${ctx.options.username}`

  const defaultStickerSet = {
    ownerId: user.id,
    name: `favorite_${ctx.from.id}`,
    title: 'Favorite stickers',
    emojiSufix: '🌟',
  }

  defaultStickerSet.title += titleSufix
  defaultStickerSet.name += nameSufix

  let file
  let emojis

  switch (ctx.updateSubTypes[0]) {
    case 'sticker':
      emojis = ctx.message.sticker.emoji || ''
      file = ctx.message.sticker
      break

    case 'document':
      if (ctx.message.documentmime_type === ['image/jpeg', 'image/png']) {
        file = ctx.message.document
      }
      break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      file = ctx.message.photo.slice(-1)[0]
      break

    default:
      console.log(ctx.updateSubTypes)
  }

  const stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)
  const sticker = await ctx.db.Sticker.findOne({ setId: stickerSet.id, 'file.file_id': file.file_id })

  if (sticker) {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
  else {
    emojis += stickerSet.emojiSufix

    if (file) {
      const fileUrl = await ctx.telegram.getFileLink(file)

      https.get(fileUrl, (response) => {
        const data = new Stream()

        response.on('data', (chunk) => {
          data.push(chunk)
        })

        response.on('end', async () => {
          const tmpPath = `tmp/${file.file_id}_${Date.now()}.png`
          const sharpImage = sharp(data.read())

          await sharpImage.png().toFile(tmpPath)

          const hash = await hasha.fromFile(tmpPath, { algorithm: 'md5' })

          let stickerAdd = false

          if (stickerSet.create === false) {
            stickerAdd = await ctx.telegram.createNewStickerSet(ctx.from.id, stickerSet.name, stickerSet.title, {
              png_sticker: { source: tmpPath },
              emojis,
            }).catch((error) => {
              ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.telegram', {
                error: error.description,
              }), {
                reply_to_message_id: ctx.message.message_id,
              })
            })

            if (stickerAdd) {
              stickerSet.create = true
              stickerSet.save()
            }
          }
          else {
            stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, stickerSet.name, {
              png_sticker: { source: tmpPath },
              emojis,
            }).catch((error) => {
              ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.telegram', {
                error: error.description,
              }), {
                reply_to_message_id: ctx.message.message_id,
              })
            })
          }

          const getStickerSet = await ctx.telegram.getStickerSet(stickerSet.name)
          const stickerInfo = getStickerSet.stickers.slice(-1)[0]

          if (stickerAdd) {
            ctx.db.Sticker.addSticker(stickerSet.id, emojis, hash, stickerInfo, file)

            ctx.replyWithHTML(ctx.i18n.t('sticker.add.ok', {
              title: stickerSet.title,
              link: `${stickerLinkPrefix}${stickerSet.name}`,
            }), {
              reply_to_message_id: ctx.message.message_id,
            })
          }

          fs.unlink(tmpPath, (err) => {
            if (err) throw err
          })
        })
      })
    }
    else {
      ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
        reply_to_message_id: ctx.message.message_id,
      })
    }
  }
}
