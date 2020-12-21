module.exports = async (ctx) => {
  let messageText = ctx.i18n.t('callback.pack.error.restore')

  if (ctx.message.entities) {
    const match = ctx.message.entities[0].url.match(/addstickers\/(.*)/)

    if (match) {
      let restored = false
      let findStickerSet
      const getStickerSet = await ctx.getStickerSet(match[1])

      if (getStickerSet.name.split('_').pop(-1) === ctx.options.username) {
        findStickerSet = await ctx.db.StickerSet.findOne({
          name: getStickerSet.name
        })

        if (findStickerSet) {
          findStickerSet.title = getStickerSet.title
          if (findStickerSet.create === true) {
            if (findStickerSet.hide === true) {
              findStickerSet.hide = false
            } else {
              const packOwner = await ctx.db.User.findById(findStickerSet.owner)
              if (!packOwner) {
                findStickerSet.owner = ctx.session.user.id
              }
            }
            findStickerSet.save()
            restored = true
          }
        } else {
          if (!ctx.session.user) ctx.session.user = await ctx.db.User.getData(ctx.from)

          findStickerSet = await ctx.db.StickerSet.newSet({
            owner: ctx.session.user.id,
            name: getStickerSet.name,
            title: getStickerSet.title,
            animated: getStickerSet.is_animated || false,
            emojiSuffix: '🌟',
            create: true
          })

          if (getStickerSet.is_animated) {
            ctx.session.user.animatedStickerSet = findStickerSet
          } else {
            ctx.session.user.stickerSet = findStickerSet
          }
          ctx.session.user.save()
          restored = true
        }

        if (restored) {
          await ctx.db.Sticker.updateMany({ stickerSet: findStickerSet }, { $set: { deleted: true } })

          getStickerSet.stickers.forEach(async (sticker) => {
            let findSticker = await ctx.db.Sticker.findOne({
              fileUniqueId: sticker.file_unique_id
            })

            if (!findSticker) {
              findSticker = new ctx.db.Sticker()

              findSticker.fileUniqueId = sticker.file_unique_id
              findSticker.emoji = sticker.emoji + findStickerSet.emojiSuffix
            }

            findSticker.deleted = false
            findSticker.fileId = sticker.file_id
            findSticker.info = sticker
            findSticker.stickerSet = findStickerSet
            findSticker.save()
          })

          messageText = ctx.i18n.t('callback.pack.restored', {
            title: findStickerSet.title,
            link: `${ctx.config.stickerLinkPrefix}${findStickerSet.name}`
          })
        }
      }
    }
  }

  await ctx.replyWithHTML(messageText, {
    reply_to_message_id: ctx.message.message_id
  })
}
