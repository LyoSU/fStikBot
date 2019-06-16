const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')


module.exports = async (ctx) => {
  ctx.replyWithChatAction('upload_document')

  if (!ctx.session.user) ctx.session.user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  if (!ctx.session.stickerSet) ctx.session.stickerSet = await ctx.db.StickerSet.findById(ctx.session.user.stickerSet)
  let stickerFile

  switch (ctx.updateSubTypes[0]) {
    case 'sticker':
      stickerFile = ctx.message.sticker
      break

    case 'document':
      if (['image/jpeg', 'image/png'].indexOf(ctx.message.documentmime_type)) {
        stickerFile = ctx.message.document
      }
      break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      stickerFile = ctx.message.photo.slice(-1)[0]
      break

    default:
      console.log(ctx.updateSubTypes)
  }

  if (ctx.session.stickerSet && stickerFile.set_name === ctx.session.stickerSet.name) {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${stickerFile.file_id}`),
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `copy_sticker:${stickerFile.file_id}`),
      ]),
    })
  }
  else if (stickerFile) {
    let findFile = stickerFile.file_id
    const originalSticker = await ctx.db.Sticker.findOne({
      'info.file_id': stickerFile.file_id,
    })

    if (originalSticker) findFile = originalSticker.file.file_id

    const sticker = await ctx.db.Sticker.findOne({
      stickerSet: ctx.session.stickerSet,
      'file.file_id': findFile,
      deleted: false,
    })

    if (sticker) {
      ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
        reply_to_message_id: ctx.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.info.file_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `copy_sticker:${sticker.info.file_id}`),
        ]),
      })
    }
    else {
      const result = await addSticker(ctx, stickerFile)

      let messageText = ''

      if (result.ok) {
        messageText = ctx.i18n.t('sticker.add.ok', {
          title: result.ok.title,
          link: result.ok.link,
        })
      }
      else if (result.error) {
        if (result.error.telegram) {
          messageText = ctx.i18n.t('error.telegram', {
            error: result.error.telegram.description,
          })
        }
      }

      ctx.replyWithHTML(messageText, {
        reply_to_message_id: ctx.message.message_id,
      })
    }
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
