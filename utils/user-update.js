module.exports = async (ctx) => {
  if (!ctx.from) return false

  let user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
    .populate('stickerSet')
    .populate('inlineStickerSet')

  const now = Math.floor(new Date().getTime() / 1000)

  if (!user) {
    user = new ctx.db.User()
    user.telegram_id = ctx.from.id
    user.first_act = now
  }

  if (ctx?.update?.my_chat_member?.new_chat_member?.status === 'kicked') {
    user.blocked = true
  } else {
    user.blocked = false
  }

  user.first_name = ctx.from.first_name
  user.last_name = ctx.from.last_name
  user.full_name = `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`
  user.username = ctx.from.username
  user.updatedAt = new Date()

  ctx.session.userInfo = user
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)
  else ctx.session.userInfo.locale = ctx.i18n.languageCode

  return true
}
