module.exports = async (ctx) => {
  let messageText = ctx.i18n.t('cmd.pack.error')

  if (ctx.message.entities) {
    const match = ctx.message.entities[0].url.match(/addstickers\/(.*)/)

    if (match) {
      const getStickerSet = await ctx.getStickerSet(match[1])

      if (getStickerSet.name.split('_').pop(-1) === ctx.options.username) {
        const findStickerSet = await ctx.db.StickerSet.findOne({
          name: getStickerSet.name,
        })

        if (findStickerSet) {
          if (findStickerSet.create === true) {
            if (findStickerSet.hide === true) {
              findStickerSet.hide = false
              findStickerSet.save()
              messageText = ctx.i18n.t('cmd.pack.restored', {
                title: findStickerSet.title,
                link: `${ctx.config.stickerLinkPrefix}${findStickerSet.name}`,
              })
            }
          }
        }
        else {
          const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })

          const stickerSet = await ctx.db.StickerSet.newSet({
            owner: user.id,
            name: getStickerSet.name,
            title: getStickerSet.title,
            emojiSuffix: '🌟',
            create: true,
          })

          user.stickerSet = stickerSet.id
          user.save()

          messageText = ctx.i18n.t('cmd.pack.restored', {
            title: stickerSet.title,
            link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
          })
        }
      }
    }
  }

  ctx.replyWithHTML(messageText, {
    reply_to_message_id: ctx.message.message_id,
  })
}
