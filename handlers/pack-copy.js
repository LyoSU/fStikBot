const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const getStickerSet = await ctx.getStickerSet(ctx.match[2]).catch(() => {})

  if (getStickerSet && getStickerSet.stickers.length > 0) {
    ctx.session.scene.copyPack = getStickerSet
    ctx.session.scene.newPack = {
      packType: getStickerSet.sticker_type,
      video: getStickerSet.is_video,
      animated: getStickerSet.is_animated,
      fillColor: getStickerSet.stickers[0].needs_repainting
    }

    await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.enter'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true,
      reply_markup: Markup.keyboard([
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ]).resize()
    })

    return ctx.scene.enter('newPack')
  }

  await ctx.replyWithHTML(ctx.i18n.t('callback.pack.error.copy'), {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
