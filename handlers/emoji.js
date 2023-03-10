const emojiRegex = require('emoji-regex')

module.exports = async (ctx) => {
  const uncleanUserInput = ctx.message.text.substring(0, 15)
  const emojiSymbols = uncleanUserInput.match(emojiRegex())
  if (emojiSymbols) {
    const emoji = emojiSymbols.join('')
    if (ctx.session.userInfo.stickerSet) {
      ctx.session.userInfo.stickerSet.emojiSuffix = emoji
      ctx.session.userInfo.stickerSet.save()
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.packs.empty'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    }
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.info'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }
}
