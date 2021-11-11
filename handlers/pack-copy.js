const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  if (ctx.session.userInfo.premium === true) {
    const getStickerSet = await ctx.getStickerSet(ctx.match[1]).catch(() => {})

    if (getStickerSet && getStickerSet.stickers.length > 0) {
      ctx.session.scene.copyPack = getStickerSet
      await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.enter'), {
        reply_to_message_id: ctx.message.message_id,
        reply_markup: Markup.keyboard([
          [
            ctx.i18n.t('scenes.btn.cancel')
          ]
        ]).resize()
      })
      return ctx.scene.enter('newPackTitle')
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.error.copy'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.error.premium'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
