const escapeHTML = (str) => str.replace(
  /[&<>'"]/g,
  (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

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
                findStickerSet.owner = ctx.session.userInfo.id
              }
            }
            findStickerSet.save()
            restored = true
          }
        } else {
          if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

          findStickerSet = await ctx.db.StickerSet.newSet({
            owner: ctx.session.userInfo.id,
            name: getStickerSet.name,
            title: getStickerSet.title,
            animated: getStickerSet.is_animated || false,
            video: getStickerSet.is_video || false,
            emojiSuffix: '🌟',
            create: true
          })

          if (getStickerSet.is_animated) {
            ctx.session.userInfo.animatedStickerSet = findStickerSet
          } else if (getStickerSet.is_video) {
            ctx.session.userInfo.videoStickerSet = findStickerSet
          } else {
            ctx.session.userInfo.stickerSet = findStickerSet
          }
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
            title: escapeHTML(findStickerSet.title),
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
