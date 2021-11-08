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
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const query = {
    owner: ctx.session.userInfo.id,
    create: true,
    private: { $ne: true },
    hide: { $ne: true }
  }
  if (ctx.updateType === 'message' && ['/packs', ctx.i18n.t('cmd.start.btn.packs')].includes(ctx.message.text)) query.animated = { $ne: true }
  else if (ctx.updateType === 'message' && ['/animpacks', ctx.i18n.t('cmd.start.btn.animpacks')].includes(ctx.message.text)) query.animated = { $ne: false }

  if (ctx.updateType === 'callback_query' && ctx.match && ctx.match[1] === 'set_pack') {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

    if (stickerSet.animated) query.animated = { $ne: false }
    else query.animated = { $ne: true }

    if (stickerSet.owner.toString() === ctx.session.userInfo.id.toString()) {
      ctx.answerCbQuery()

      if (stickerSet.animated) ctx.session.userInfo.animatedStickerSet = stickerSet
      if (stickerSet.animated === false) ctx.session.userInfo.stickerSet = stickerSet

      const btnName = stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'

      if (stickerSet.private) {
        await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_private_pack', {
          botUsername: ctx.options.username
        }), {
          reply_markup: Markup.inlineKeyboard([
            Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_private'), '')
          ]),
          parse_mode: 'HTML'
        })
      } else {
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
      }
    } else {
      ctx.answerCbQuery('error', true)
    }
  }

  let privateSet = await ctx.db.StickerSet.findOne({
    owner: ctx.session.userInfo.id,
    private: true
  })

  if (!privateSet) {
    privateSet = await ctx.db.StickerSet.newSet({
      owner: ctx.session.userInfo.id,
      name: 'private_' + ctx.from.id,
      title: 'private',
      emojiSuffix: '🌟',
      create: true,
      private: true
    })
  }

  privateSet.title = ctx.i18n.t('cmd.packs.private_title')

  const stickerSets = await ctx.db.StickerSet.find(query).sort({
    updatedAt: -1
  }).limit(50)

  stickerSets.unshift(privateSet)

  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0) {
    messageText = ctx.i18n.t('cmd.packs.info')
    const selectedStickerSet = (query.animated.$ne === true) ? ctx.session.userInfo.stickerSet : ctx.session.userInfo.animatedStickerSet

    stickerSets.forEach((pack) => {
      let { title } = pack
      if (selectedStickerSet) {
        if (selectedStickerSet.id.toString() === pack.id.toString()) title = `✅ ${title}`
      }
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
