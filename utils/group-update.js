module.exports = async (ctx, next) => {
  let group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })

  if (!group) {
    group = new ctx.db.Group()
    group.telegram_id = ctx.chat.id
  }

  group.title = ctx.chat.title
  group.username = ctx.chat.username
  group.settings = group.settings || new ctx.db.Group().settings

  group.updatedAt = new Date()

  await group.save()

  return next()
}
