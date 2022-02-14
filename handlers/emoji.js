module.exports = async (ctx) => {
  const uncleanUserInput = ctx.message.text.substring(0, 15)
  const emojiRegExp = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g
  const emojiSymbols = uncleanUserInput.match(emojiRegExp)
  if (emojiSymbols) {
    const emoji = emojiSymbols.join('')
    if (ctx.session.userInfo.stickerSet) {
      ctx.session.userInfo.stickerSet.emojiSuffix = emoji
      ctx.session.userInfo.stickerSet.save()
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
        reply_to_message_id: ctx.message.message_id
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.packs.empty'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  } else {
    ctx.session.userInfo.autoEmoji = !ctx.session.userInfo.autoEmoji
    if (ctx.session.userInfo.autoEmoji) {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.enabled'), {
        reply_to_message_id: ctx.message.message_id
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.disabled'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  }
}
