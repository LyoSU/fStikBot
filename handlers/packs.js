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

module.exports = async (ctx) => {
  if (!ctx.session.user) ctx.session.user = await ctx.db.User.getData(ctx.from)
  const stickerSets = await ctx.db.StickerSet.find({
    owner: ctx.session.user.id,
    animated: { $ne: true },
    create: true,
    hide: false
  })

  if (ctx.updateType === 'callback_query' && ctx.match && ctx.match[1] === 'set_pack') {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

    if (stickerSet.owner.toString() === ctx.session.user.id.toString()) {
      ctx.answerCbQuery()
      ctx.session.user.stickerSet = stickerSet
      ctx.session.user.save()

      const btnName = stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'

      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_pack', {
        title: escapeHTML(stickerSet.title),
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
      }), {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
          ]
        ])
      })
    } else {
      ctx.answerCbQuery('error', true)
    }
  }

  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0) {
    messageText = ctx.i18n.t('cmd.packs.info')

    stickerSets.forEach((pack) => {
      let { title } = pack

      if (ctx.session.user.stickerSet.id.toString() === pack.id.toString()) title = `✅ ${title}`
      keyboardMarkup.push([Markup.callbackButton(title, `set_pack:${pack.id}`)])
    })
  } else {
    messageText = ctx.i18n.t('cmd.packs.empty')
  }

  if (ctx.updateType === 'message') {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard(keyboardMarkup)
    })
  } else if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(messageText, {
      reply_markup: Markup.inlineKeyboard(keyboardMarkup),
      parse_mode: 'HTML'
    }).catch(() => {})
  }
}
