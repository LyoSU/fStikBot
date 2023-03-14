const emojiRegex = require('emoji-regex')

module.exports = async (ctx, next) => {
  if (ctx.session.previousSticker && ctx.session?.userInfo?.stickerSet?.inline) {
    if (ctx.message.text.startsWith('/')) {
      ctx.session.previousSticker = null
      return next()
    }

    const sticker = await ctx.db.Sticker.findById(ctx.session.previousSticker.id)

    if (sticker) {
      sticker.emojis = ctx.message.text
      await sticker.save()

      ctx.session.previousSticker = null

      return ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    } else {
      return next()
    }
  } else if (ctx.session?.userInfo?.stickerSet?.inline) {
    return next()
  }

  if (
    ctx.message.text.match(/[a-zA-Zа-яА-Я]/)
  ) return next()

  let sticker

  if (ctx.session.previousSticker) {
    sticker = await ctx.db.Sticker.findById(ctx.session.previousSticker.id)
  } else if (ctx.session.userInfo.stickerSet) {
    const stickerSetInfo = await ctx.tg.getStickerSet(ctx.session.userInfo.stickerSet.name).catch(() => {})

    if (!stickerSetInfo || stickerSetInfo.stickers.length < 1) {
      return next()
    }

    const stickerInfo = stickerSetInfo.stickers[stickerSetInfo.stickers.length - 1]

    sticker = await ctx.db.Sticker.findOne({
      stickerSet: ctx.session.userInfo.stickerSet,
      fileUniqueId: stickerInfo.file_unique_id,
      deleted: false
    })

    if (!sticker) {
      return next()
    }
  } else {
    return next()
  }

  const regex = emojiRegex()
  const emojis = ctx.message.text.match(regex)

  if (!emojis || emojis.length === 0) {
    return next()
  }

  const updateResult = await ctx.tg.callApi('setStickerEmojiList', {
    sticker: sticker.info.file_id,
    emoji_list: emojis
  }).catch((error) => {
    console.log(error)
  })

  if (updateResult) {
    sticker.emoji = emojis.join(' ')
    await sticker.save()

    await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.error'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }
}
