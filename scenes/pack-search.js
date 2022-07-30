const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')

const escapeHTML = (str) => str.replace(
  /[&<>'"]/g,
  (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

const searchStickerSet = new Scene('searchStickerSet')

searchStickerSet.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.search.enter'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

searchStickerSet.on('text', async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.find({
    public: true,
    $text: { $search: ctx.message.text }
  }).limit(100)

  if (stickerSet?.length > 0) {
    const packList = []

    for (const pack of stickerSet) {
      const stickerSetInfo = await ctx.telegram.getStickerSet(pack.name).catch(() => null)

      if (stickerSetInfo && stickerSetInfo.stickers.length > 0) {
        packList.push(`<a href="${ctx.config.stickerLinkPrefix}${pack.name}">${escapeHTML(pack.title)}</a>`)
      }
    }

    if (packList.length > 0) {
      return ctx.replyWithHTML(packList.join('\n'))
    }
  }

  return ctx.replyWithHTML(ctx.i18n.t('scenes.search.error.not_found'), {
    reply_to_message_id: ctx.message.message_id
  })
})

module.exports = [searchStickerSet]
