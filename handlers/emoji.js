const emojiRegex = require('emoji-regex')
const { sendBanner } = require('../banners')
const coedit = require('../utils/coedit')

// The selected pack can belong to somebody else (a co-edit link, /public).
// Pack-wide settings need the "settings" right: the owner and editors.
const canEditPackSettings = async (ctx, stickerSet) => coedit.can(await coedit.getAccess(ctx, stickerSet), 'settings')

module.exports = async (ctx) => {
  const uncleanUserInput = ctx.message.text.substring(0, 15)
  const emojiSymbols = uncleanUserInput.match(emojiRegex())
  if (emojiSymbols) {
    const emoji = emojiSymbols.join('')
    if (ctx.session.userInfo.stickerSet && !await canEditPackSettings(ctx, ctx.session.userInfo.stickerSet)) {
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
