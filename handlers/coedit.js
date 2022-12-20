const StegCloak = require('stegcloak')
const Composer = require('telegraf/composer')
const crypto = require('crypto')

const generatePasscode = () => {
  return crypto.randomBytes(4).toString('hex')
}

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

const composer = new Composer()

composer.action(/coedit:reset:(.*)/, async (ctx) => {
  const stickerSetId = ctx.match[1]

  const stickerSet = await ctx.db.StickerSet.findById(stickerSetId)

  if (!stickerSet) {
    return ctx.answerCbQuery('error', true)
  }

  if (stickerSet?.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery('error', true)
  }

  stickerSet.passcode = generatePasscode()

  await stickerSet.save()

  await ctx.db.User.updateMany({
    stickerSet: stickerSet._id
  }, {
    stickerSet: null
  })

  return ctx.replyWithHTML(ctx.i18n.t('coedit.reset', {
    colink:`t.me/${ctx.botInfo.username}?start=s_${stickerSet.passcode}`,
    title: escapeHTML(stickerSet.title),
    link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
  }))
})

composer.action(/coedit:(.*)/, async (ctx) => {
  const stickerSetId = ctx.match[1]

  const stickerSet = await ctx.db.StickerSet.findById(stickerSetId)

  if (!stickerSet) {
    return ctx.answerCbQuery('error', true)
  }

  if (stickerSet?.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery('error', true)
  }

  if (!stickerSet.passcode) {
    stickerSet.passcode = generatePasscode()

    await stickerSet.save()
  }

  const editorsList = await ctx.db.User.find({
    stickerSet: stickerSet._id
  })

  const editors = editorsList.map((user) => {
    return `<a href="tg://user?id=${user.telegram_id}">${escapeHTML(user.first_name)}</a>`
  }).join(', ') || ctx.i18n.t('coedit.no_editors')

  return ctx.replyWithHTML(ctx.i18n.t('coedit.info', {
    colink:`t.me/${ctx.botInfo.username}?start=s_${stickerSet.passcode}`,
    title: escapeHTML(stickerSet.title),
    link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`,
    editors
  }), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: ctx.i18n.t('coedit.btn.send'),
          url: `https://t.me/share/url?url=t.me/${ctx.botInfo.username}?start=s_${stickerSet.passcode}&text=${
            encodeURIComponent(
              ctx.i18n.t('coedit.share', {
                title: escapeHTML(stickerSet.title)
              })
            )
          }`
        }],
        [{
          text: ctx.i18n.t('coedit.btn.reset'),
          callback_data: `coedit:reset:${stickerSet._id}`
        }]
      ]
    }
  })

})

module.exports = composer
