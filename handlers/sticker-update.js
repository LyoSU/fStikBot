const emojiRegex = require('emoji-regex')

module.exports = async (ctx, next) => {
  if (
    !ctx.session.previousSticker ||
    ctx.message.text.match(/[a-zA-Zа-яА-Я]/)
  ) return next()

  ctx.replyWithChatAction('upload_document').catch(() => {})

  const sticker = await ctx.db.Sticker.findById(ctx.session.previousSticker.id)

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
      reply_to_message_id: ctx.message.message_id
    })
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.error'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
