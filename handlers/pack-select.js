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

  let passcode

  if (ctx.startPayload) passcode = ctx.startPayload.match(/s_(.*)/)[1]
  if (ctx?.message?.text === '/public') passcode = 'public'

  const stickerSet = await ctx.db.StickerSet.findOne({
    passcode
  })

  if (!stickerSet) {
    return ctx.replyWithHTML('error')
  }

  if (stickerSet.owner.toString() === userInfo.id.toString() || stickerSet.passcode === passcode) {
    if (stickerSet.inline) {
      userInfo.inlineStickerSet = stickerSet
      userInfo.animatedStickerSet = null
    }

    if (stickerSet.video) {
      userInfo.videoStickerSet = stickerSet
      userInfo.stickerSet = stickerSet
    } else if (stickerSet.animated) {
      userInfo.animatedStickerSet = stickerSet
      if (userInfo?.stickerSet?.inline) {
        userInfo.stickerSet = null
      }
    } else {
      userInfo.stickerSet = stickerSet
    }

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
      let type = 'static'
      if (stickerSet.animated) type = 'animated'
      if (stickerSet.video) type = 'video'

      await ctx. replyWithHTML(ctx.i18n.t(`callback.pack.set_pack.${type}`, {
        title: escapeHTML(stickerSet.title),
        link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
      }), {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${ctx.config.stickerLinkPrefix}${stickerSet.name}`)
          ]
        ]),
        parse_mode: 'HTML'
      })
    }
  } else {
    await ctx.replyWithHTML('error')
  }
}
