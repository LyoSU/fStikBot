const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const stickerSets = await ctx.db.StickerSet.find({ ownerId: user.id })

  if (ctx.updateType === 'callback_query' && ctx.match) {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[1])

    if (stickerSet.ownerId.toString() === user.id.toString()) {
      ctx.answerCbQuery()
      user.stickerSet = stickerSet.id
      user.save()

      ctx.replyWithHTML(ctx.i18n.t('cmd.packs.set_pack', {
        title: stickerSet.title,
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
      }), {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
      })
    }
    else {
      ctx.answerCbQuery('error', true)
    }
  }

  const markup = []

  stickerSets.forEach((pack) => {
    let { title } = pack

    if (user.stickerSet.toString() === pack.id.toString()) title = `✔️ ${title}`

    markup.push([Markup.callbackButton(title, `set_pack:${pack.id}`)])
  })

  if (ctx.updateType === 'message') {
    ctx.replyWithHTML(ctx.i18n.t('cmd.packs.info'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard(markup),
    })
  }
  else if (ctx.updateType === 'callback_query') {
    ctx.editMessageReplyMarkup(Markup.inlineKeyboard(markup)).catch(() => {})
  }
}
