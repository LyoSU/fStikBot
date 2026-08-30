const Markup = require('telegraf/markup')
const { humanizeTelegramError, matchTelegramErrorReason } = require('../utils/telegram-error')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  let getStickerSet
  let fetchError
  try {
    getStickerSet = await ctx.telegram.getStickerSet(ctx.match[2])
  } catch (err) {
    fetchError = err
    console.error('pack-copy: getStickerSet failed:', err.message)
  }

  if (getStickerSet && getStickerSet.stickers.length > 0) {
    // Determine pack format from stickers (StickerSet doesn't have is_video/is_animated)
    const hasVideo = getStickerSet.stickers.some(s => s.is_video)
    const hasAnimated = getStickerSet.stickers.some(s => s.is_animated)
    // Handed to the scene as enter-state: newPack.enter rebuilds session.scene
    // from it, so nothing left over from an abandoned wizard survives.
    const sceneState = {
      copyPack: getStickerSet,
      newPack: {
        packType: getStickerSet.sticker_type,
        video: hasVideo,
        animated: hasAnimated,
        fillColor: getStickerSet.stickers[0].needs_repainting
      }
    }

    await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.enter'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true,
      reply_markup: Markup.keyboard([
        [
          { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
        ]
      ]).resize()
    })

    return ctx.scene.enter('newPack', sceneState)
  }

  // Surface the specific cause (rate-limited, pack deleted, etc.) when we
  // have a Telegram error to interpret; otherwise fall back to the
  // generic "pack not found" copy.
  const errorText = fetchError && matchTelegramErrorReason(fetchError)
    ? humanizeTelegramError(ctx, fetchError)
    : ctx.i18n.t('callback.pack.error.copy')

  await ctx.replyWithHTML(errorText, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
