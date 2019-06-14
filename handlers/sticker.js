const Markup = require('telegraf/markup')
const { addSticker } = require('../utils')


module.exports = async (ctx) => {
  ctx.replyWithChatAction('upload_document')

  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate('stickerSet')
  let file

  switch (ctx.updateSubTypes[0]) {
    case 'sticker':
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

  if (user.stickerSet && file.set_name === user.stickerSet.name) {
    ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${file.file_id}`),
      ]),
    })
  }
  else if (file) {
    const sticker = await ctx.db.Sticker.findOne({
      stickerSet: user.stickerSet,
      'file.file_id': file.file_id,
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
      const result = await addSticker(ctx, file)

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
