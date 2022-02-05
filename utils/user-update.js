module.exports = async (ctx) => {
  let user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
    .populate('stickerSet')
    .populate('videoStickerSet')
    .populate('inlineStickerSet')
    .populate('animatedStickerSet')

  const now = Math.floor(new Date().getTime() / 1000)

  if (!user) {
    user = new ctx.db.User()
    user.telegram_id = ctx.from.id
    user.first_act = now
  }
  user.first_name = ctx.from.first_name
  user.last_name = ctx.from.last_name
  user.full_name = `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`
  user.username = ctx.from.username
  user.blocked = false
  user.updatedAt = new Date()

  ctx.session.userInfo = user
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)
  else ctx.session.userInfo.locale = ctx.i18n.languageCode

  return true
}
