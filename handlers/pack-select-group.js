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

module.exports = async (ctx, next) => {
  const packsName = ctx.message.text.split(' ')[1]

  if (!packsName) {
    return next()
  }

  await ctx.deleteMessage().catch(() => {})

  const { userInfo } = ctx.session

  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return
  }

  if (!ctx.message.from || !ctx.message.from.id) {
    return
  }

  const isAdmin = await ctx.telegram.getChatAdministrators(ctx.chat.id)
    .then((admins) => admins.some((admin) => admin.user.id === ctx.message.from.id))

  if (!isAdmin) {
    return
  }

  const stickerSet = await ctx.db.StickerSet.findOne({
    name: packsName,
    owner: userInfo.id
  })

  if (!stickerSet) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.select_group.error'))
  }

  const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })

  if (!group) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.select_group.error'))
  }

  group.stickerSet = stickerSet
  group.updatedAt = new Date()

  await group.save()

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.select_group.access_rights.add'), 'group_settings add')],
    [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.select_group.access_rights.delete'), 'group_settings delete')]
  ])

  return ctx.replyWithHTML(ctx.i18n.t('callback.pack.select_group.success', {
    link: `t.me/addstickers/${stickerSet.name}`,
    title: escapeHTML(stickerSet.title)
  }), {
    reply_markup: inlineKeyboard,
    disable_web_page_preview: true
  })
}
