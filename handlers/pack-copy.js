const { humanizeTelegramError, matchTelegramErrorReason } = require('../utils/telegram-error')

// A pack link from someone else's pack starts the copy wizard. The copy keeps
// the source's type and asks only for a title (see scenes/pack-new.js).
module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  let getStickerSet
  let fetchError
  try {
    getStickerSet = await ctx.telegram.getStickerSet(ctx.match[2])
  } catch (err) {
    fetchError = err
  }

  if (getStickerSet && getStickerSet.stickers.length > 0) {
    return ctx.scene.enter('newPack', {
      copyPack: getStickerSet,
      newPack: {
        packType: getStickerSet.sticker_type,
        fillColor: !!getStickerSet.stickers[0].needs_repainting
      }
    })
  }

  // Surface the specific cause (rate-limited, pack deleted, etc.) when we
  // have a Telegram error to interpret; otherwise "pack not found".
  const errorText = fetchError && matchTelegramErrorReason(fetchError)
    ? humanizeTelegramError(ctx, fetchError)
    : ctx.i18n.t('callback.pack.error.copy')

  await ctx.replyWithHTML(errorText, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
