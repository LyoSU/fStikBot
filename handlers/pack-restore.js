const { escapeHTML } = require('../utils')

module.exports = async (ctx, next) => {
  let messageText = ctx.i18n.t('callback.pack.error.restore')

  let restored = false
  const findStickerSet = await ctx.db.StickerSet.findOne({
    name: ctx.match[2],
    owner: ctx.session.userInfo.id,
    thirdParty: false
  })

  if (!findStickerSet) {
    return next()
  }

  const getStickerSet = await ctx.getStickerSet(ctx.match[2]).catch(() => {})

  if (!getStickerSet) {
    return next()
  }

  if (getStickerSet.name.split('_').pop(-1) === ctx.options.username) {
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

  await ctx.replyWithHTML(messageText, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
