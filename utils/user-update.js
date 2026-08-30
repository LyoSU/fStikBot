module.exports = async (ctx) => {
  if (!ctx.from) return false

  // Only populate inlineStickerSet when the handler actually reads it —
  // inline queries hit it hard, regular message/callback flows never do.
  // Saves one findById per regular update (~3ms steady, ~30-100ms under
  // pool pressure) for the ~95% of updates that aren't inline queries.
  // Same projection User.getData uses — without a select this pulled the full
  // StickerSet document into the session on every single update.
  let query = ctx.db.User.findOne({ telegram_id: ctx.from.id }).populate({
    path: 'stickerSet',
    // placeholderFileUniqueId must survive this projection: uploadSticker's
    // placeholder cleanup reads it off the session doc, and without it the
    // guard sees "no placeholder" and silently skips the removal.
    select: '_id name title packType inline create emojiSuffix frameType boost hide owner passcode public publishDate placeholderFileUniqueId'
  })
  if (ctx.inlineQuery) {
    query = query.populate({
      path: 'inlineStickerSet',
      select: '_id name title inline'
    })
  }

  let user = await query

  // Bot API formally guarantees ctx.from.first_name, but deactivated /
  // deleted accounts and rare anonymous-sender edges send it empty or
  // missing. Coerce both to '' once so neither schema validation nor
  // template-literal interpolation surprises us downstream.
  const firstName = ctx.from.first_name || ''
  const lastName = ctx.from.last_name || ''
  const fullName = lastName ? `${firstName} ${lastName}` : firstName

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
          first_name: firstName,
          last_name: lastName,
          full_name: fullName,
          username: ctx.from.username
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
  }

  // my_chat_member fires for groups too, and there ctx.from is the person who
  // removed the bot — flagging them as blocked dropped a real user out of every
  // broadcast. Only a private chat means "this user blocked the bot".
  const myChatMember = ctx?.update?.my_chat_member

  if (!myChatMember || myChatMember.chat?.type === 'private') {
    user.blocked = myChatMember?.new_chat_member?.status === 'kicked'
  }

  user.first_name = firstName
  user.last_name = lastName
  user.full_name = fullName
  user.username = ctx.from.username
  // No manual updatedAt — see save-wrap in bot/middleware.js. We bump it
  // via a throttled fire-and-forget updateOne instead, so unchanged-user
  // updates don't trigger a full .save() on every request.

  ctx.session.userInfo = user
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)
  else ctx.session.userInfo.locale = ctx.i18n.languageCode

  return true
}
