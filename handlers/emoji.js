const emojiRegex = require('emoji-regex')
const { sendBanner } = require('../banners')

// The selected pack can belong to somebody else: /public and the co-edit link
// let a stranger select a pack they don't own. The owner and co-editors (anyone
// who got in via the secret /coedit passcode) may change pack-wide settings;
// the shared demo pack (passcode 'public', selectable by everyone) may not.
const canEditPackSettings = (ctx, stickerSet) => {
  if (!stickerSet) return false
  const ownerId = stickerSet.owner && stickerSet.owner.toString()
  if (ownerId && ownerId === ctx.session.userInfo.id.toString()) return true
  return stickerSet.passcode !== 'public'
}

module.exports = async (ctx) => {
  const uncleanUserInput = ctx.message.text.substring(0, 15)
  const emojiSymbols = uncleanUserInput.match(emojiRegex())
  if (emojiSymbols) {
    const emoji = emojiSymbols.join('')
    if (ctx.session.userInfo.stickerSet && !canEditPackSettings(ctx, ctx.session.userInfo.stickerSet)) {
      await ctx.replyWithHTML(ctx.i18n.t('error.access_denied'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    } else if (ctx.session.userInfo.stickerSet) {
      await ctx.db.StickerSet.updateOne(
        { _id: ctx.session.userInfo.stickerSet._id },
        { emojiSuffix: emoji }
      )
      ctx.session.userInfo.stickerSet.emojiSuffix = emoji
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.done'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.emoji.no_pack_selected'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    }
  } else {
    await sendBanner(ctx, 'emoji', ctx.i18n.t('cmd.emoji.info'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }
}
