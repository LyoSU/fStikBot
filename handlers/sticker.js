const fs = require('fs')
const https = require('https')
const Stream = require('stream').Transform
const sharp = require('sharp')
const hasha = require('hasha')
const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  ctx.replyWithChatAction('upload_document')

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

  defaultStickerSet.title += titleSufix
  defaultStickerSet.name += nameSufix

  if (!stickerSet) stickerSet = await ctx.db.StickerSet.getSet(defaultStickerSet)

  let file
  let emojis = ''

  switch (ctx.updateSubTypes[0]) {
    case 'sticker':
      emojis = ctx.message.sticker.emoji || ''
      file = ctx.message.sticker
      break

    case 'document':
      if (['image/jpeg', 'image/png'].indexOf(ctx.message.documentmime_type)) {
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

  if (file.set_name === stickerSet.name) {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('cmd.sticker.btn.delete'), `delete_sticker:${file.file_id}`),
      ]),
    })
  }
  else if (file) {
    const sticker = await ctx.db.Sticker.findOne({
      stickerSet: stickerSet.id,
      'file.file_id': file.file_id,
      deleted: false,
    })

    if (sticker) {
      ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
        reply_to_message_id: ctx.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('cmd.sticker.btn.delete'), `delete_sticker:${sticker.info.file_id}`),
        ]),
      })
    }
    else {
      const fileUrl = await ctx.telegram.getFileLink(file)

      emojis += stickerSet.emojiSufix || ''

      https.get(fileUrl, (response) => {
        const data = new Stream()

        response.on('data', (chunk) => {
          data.push(chunk)
        })

        response.on('end', async () => {
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
              ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.telegram', {
                error: error.description,
              }), {
                reply_to_message_id: ctx.message.message_id,
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
              link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
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
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
