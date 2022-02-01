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
  const { userInfo } = ctx.session

  if (!userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const query = {
    owner: userInfo.id,
    create: true,
    inline: { $ne: true },
    animated: { $ne: true },
    video: { $ne: true },
    hide: { $ne: true }
  }

  if (ctx.updateType === 'callback_query' && ctx.match && ctx.match[1] === 'set_pack') {
    const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

    if (stickerSet.animated) {
      ctx.state.type = 'animated'
      query.animated = true
    }

    if (stickerSet.video) {
      ctx.state.type = 'video'
      query.video = true
    }

    if (stickerSet.owner.toString() === userInfo.id.toString()) {
      await ctx.answerCbQuery()

      if (stickerSet.inline) {
        ctx.state.type = 'inline'
        userInfo.inlineStickerSet = stickerSet
        userInfo.animatedStickerSet = null
      }

      if (stickerSet.animated) {
        userInfo.animatedStickerSet = stickerSet
        if (userInfo.stickerSet && userInfo.stickerSet.inline) {
          userInfo.stickerSet = null
        }
      } else userInfo.stickerSet = stickerSet

      const btnName = stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'

      if (stickerSet.inline) {
        await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_inline_pack', {
          title: escapeHTML(stickerSet.title),
          botUsername: ctx.options.username
        }), {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
            ],
            [
              Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
            ]
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
              Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${ctx.config.stickerLinkPrefix}${stickerSet.name}`)
            ],
            [
              Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
            ]
          ]),
          parse_mode: 'HTML'
        })
      }
    } else {
      await ctx.answerCbQuery('error', true)
    }
  }

  if (ctx.state.type === 'animated') query.animated = true
  else if (ctx.state.type === 'inline') query.inline = true
  else if (ctx.state.type === 'video') query.video = true

  const stickerSets = await ctx.db.StickerSet.find(query).sort({
    updatedAt: -1
  }).limit(50)

  if (ctx.state.type === 'inline' && stickerSets.length <= 0) {
    let inlineSet = await ctx.db.StickerSet.findOne({
      owner: userInfo.id,
      inline: true
    })

    if (!inlineSet) {
      inlineSet = await ctx.db.StickerSet.newSet({
        owner: userInfo.id,
        name: 'inline_' + ctx.from.id,
        title: ctx.i18n.t('cmd.packs.inline_title'),
        emojiSuffix: '💫',
        create: true,
        inline: true
      })
    }

    stickerSets.unshift(inlineSet)
  }

  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0) {
    messageText = ctx.i18n.t('cmd.packs.info')

    let selectedStickerSet
    if (ctx.state.type === 'animated') selectedStickerSet = userInfo.animatedStickerSet
    else selectedStickerSet = userInfo.stickerSet

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

  keyboardMarkup.push([Markup.callbackButton(ctx.i18n.t('cmd.start.btn.new'), 'new_pack')])

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
