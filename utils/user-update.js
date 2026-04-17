module.exports = async (ctx) => {
  if (!ctx.from) return false

  // Only populate inlineStickerSet when the handler actually reads it —
  // inline queries hit it hard, regular message/callback flows never do.
  // Saves one findById per regular update (~3ms steady, ~30-100ms under
  // pool pressure) for the ~95% of updates that aren't inline queries.
  let query = ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate('stickerSet')
  if (ctx.inlineQuery) {
    query = query.populate('inlineStickerSet')
  }

  let user = await query

  if (!user) {
    // First-message race: two parallel updates both see `null` here and
    // would both `new User() + save()`, producing E11000 on the second.
    // Atomic upsert ensures one wins and the other gets the inserted doc.
    const now = Math.floor(Date.now() / 1000)
    user = await ctx.db.User.findOneAndUpdate(
      { telegram_id: ctx.from.id },
      {
        $setOnInsert: {
          telegram_id: ctx.from.id,
          first_act: now,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
          full_name: `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`,
          username: ctx.from.username
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
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
  // No manual updatedAt — see save-wrap in bot/middleware.js. We bump it
  // via a throttled fire-and-forget updateOne instead, so unchanged-user
  // updates don't trigger a full .save() on every request.

  ctx.session.userInfo = user
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)
  else ctx.session.userInfo.locale = ctx.i18n.languageCode

  return true
}
