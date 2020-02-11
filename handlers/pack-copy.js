const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.user) ctx.session.user = await ctx.db.User.getData(ctx.from)

  if (ctx.session.user.premium === true) {
    const getStickerSet = await ctx.getStickerSet(ctx.match[1]).catch(() => {})

    if (getStickerSet && getStickerSet.stickers.length > 0) {
      if (getStickerSet.is_animated !== true) {
        ctx.session.scane.copyPack = getStickerSet
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.enter'), {
          reply_to_message_id: ctx.message.message_id,
          reply_markup: Markup.keyboard([
            [
              ctx.i18n.t('scenes.btn.cancel')
            ]
          ]).resize()
        })
        ctx.scene.enter('newPack')
      } else {
        ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type'), {
          reply_to_message_id: ctx.message.message_id
        })
      }
    } else {
      ctx.replyWithHTML(ctx.i18n.t('callback.pack.error.copy'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  } else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.copy.error.premium'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
