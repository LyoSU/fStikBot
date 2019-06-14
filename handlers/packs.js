const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const stickerSets = await ctx.db.StickerSet.find({ owner: user.id, create: true, hide: false })

  if (ctx.updateType === 'callback_query' && ctx.match && ctx.match[1] === 'set_pack') {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

    if (stickerSet.owner.toString() === user.id.toString()) {
      ctx.answerCbQuery()
      user.stickerSet = stickerSet.id
      user.save()

      const btnName = stickerSet.hide === true ? 'cmd.pack.btn.restore' : 'cmd.pack.btn.hide'

      ctx.replyWithHTML(ctx.i18n.t('cmd.packs.set_pack', {
        title: stickerSet.title,
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
      }), {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`),
          ],
        ]),
      })
    }
    else {
      ctx.answerCbQuery('error', true)
    }
  }

  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0) {
    messageText = ctx.i18n.t('cmd.packs.info')

    stickerSets.forEach((pack) => {
      let { title } = pack

      if (user.stickerSet.toString() === pack.id.toString()) title = `✔️ ${title}`
      keyboardMarkup.push([Markup.callbackButton(title, `set_pack:${pack.id}`)])
    })
  }
  else {
    messageText = ctx.i18n.t('cmd.packs.empty')
  }

  if (ctx.updateType === 'message') {
    ctx.replyWithHTML(messageText, {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard(keyboardMarkup),
    })
  }
  else if (ctx.updateType === 'callback_query') {
    ctx.editMessageText(messageText, {
      reply_markup: Markup.inlineKeyboard(keyboardMarkup),
      parse_mode: 'HTML',
    }).catch(() => {})
  }
}
