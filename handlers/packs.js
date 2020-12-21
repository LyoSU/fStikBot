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

  const query = {
    owner: ctx.session.user.id,
    create: true,
    hide: false
  }
  if (ctx.updateType === 'message' && ['/packs', ctx.i18n.t('cmd.start.btn.packs')].includes(ctx.message.text)) query.animated = { $ne: true }
  else if (ctx.updateType === 'message' && ['/animpacks', ctx.i18n.t('cmd.start.btn.animpacks')].includes(ctx.message.text)) query.animated = { $ne: false }

  if (ctx.updateType === 'callback_query' && ctx.match && ctx.match[1] === 'set_pack') {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

    if (stickerSet.owner.toString() === ctx.session.user.id.toString()) {
      ctx.answerCbQuery()

      if (stickerSet.animated) ctx.session.user.animatedStickerSet = stickerSet
      if (stickerSet.animated === false) ctx.session.user.stickerSet = stickerSet
      ctx.session.user.save()

      const btnName = stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'

      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_pack', {
        title: escapeHTML(stickerSet.title),
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
      }), {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
          ]
        ]),
        parse_mode: 'HTML'
      })
    } else {
      ctx.answerCbQuery('error', true)
    }
  }

  const stickerSets = await ctx.db.StickerSet.find(query)
  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0 && ctx.updateType === 'message') {
    messageText = ctx.i18n.t('cmd.packs.info')

    stickerSets.forEach((pack) => {
      let { title } = pack
      const selectedStickerSet = (query.animated.$ne === true) ? ctx.session.user.stickerSet.id : ctx.session.user.animatedStickerSet.id
      if (selectedStickerSet.toString() === pack.id.toString()) title = `✅ ${title}`
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
  }
}
