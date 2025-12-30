const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { escapeHTML } = require('../utils')

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
  const stickerSets = await ctx.db.StickerSet.find({
    public: true,
    $text: { $search: ctx.message.text }
  }).select('name title').limit(100).lean()

  if (stickerSets && stickerSets.length > 0) {
    // Batch verify packs with Telegram API (parallel with concurrency limit)
    const BATCH_SIZE = 10
    const packList = []

    for (let i = 0; i < stickerSets.length; i += BATCH_SIZE) {
      const batch = stickerSets.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(pack =>
          ctx.telegram.getStickerSet(pack.name)
            .then(info => ({ pack, info }))
            .catch(() => ({ pack, info: null }))
        )
      )

      for (const { pack, info } of results) {
        if (info && info.stickers && info.stickers.length > 0) {
          packList.push(`<a href="${ctx.config.stickerLinkPrefix}${pack.name}">${escapeHTML(pack.title)}</a>`)
        }
      }
    }

    if (packList.length > 0) {
      return ctx.replyWithHTML(packList.join('\n'))
    }
  }

  return ctx.replyWithHTML(ctx.i18n.t('scenes.search.error.not_found'), {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
})

module.exports = [searchStickerSet]
