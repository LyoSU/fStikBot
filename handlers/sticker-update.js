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

    // The delete button doesn't touch session.previousSticker, so after
    // "add → delete → send emoji" we used to hit Telegram with a dead file_id
    // (STICKER_ALREADY_DELETED). Fall through to the last sticker in the set.
    if (sticker?.deleted) {
      sticker = null
      ctx.session.previousSticker = null
    }
  }

  if (!sticker && ctx.session.userInfo.stickerSet) {
    const stickerSetInfo = await ctx.tg.getStickerSet(ctx.session.userInfo.stickerSet.name).catch(() => null) // STICKERSET_INVALID / deleted pack → caller handles null below

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
  } else if (!sticker) {
    return next()
  }

  const regex = emojiRegex()
  const emojis = ctx.message.text.match(regex)

  if (!emojis || emojis.length === 0) {
    return next()
  }

  // Bot API allows 1–20 emoji per sticker; more came back as a raw Telegram
  // error instead of just working.
  if (emojis.length > 20) emojis.length = 20

  const updateResult = await ctx.tg.callApi('setStickerEmojiList', {
    sticker: sticker.getFileId(),
    emoji_list: emojis
  }).catch(async (error) => {
    const description = error?.description || error?.message || ''
    console.error('setStickerEmojiList failed:', description)

    // Telegram says the sticker is gone (removed via a client / @Stickers)
    // while our row still says deleted:false — sync so the next attempt
    // doesn't retarget the same ghost.
    if (/STICKER_ALREADY_DELETED|STICKER_INVALID/i.test(description)) {
      sticker.deleted = true
      sticker.deletedAt = new Date()
      await sticker.save().catch(() => {})
      ctx.session.previousSticker = null
    }
  })

  if (updateResult) {
    sticker.emojis = emojis.join(' ')
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
