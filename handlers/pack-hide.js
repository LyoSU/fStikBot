const { editPackMenu, isOwner } = require('./pack-menu')

// hide_pack:<id> toggles a pack between the list and "Hidden".
module.exports = async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2]).catch(() => null)

  if (!stickerSet) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
  }

  if (!isOwner(ctx, stickerSet)) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  const hide = stickerSet.hide !== true
  // Conditional on the current value, so a double tap can't count twice.
  const updated = await ctx.db.StickerSet.findOneAndUpdate(
    { _id: stickerSet._id, hide: hide ? { $ne: true } : true },
    { $set: { hide } },
    { new: true }
  )
  if (!updated) return ctx.answerCbQuery()

  // The cached per-type count is reset rather than adjusted: /packs recounts a
  // zero, while +1/-1 on a count that was never cached made it wrong for good.
  const countType = updated.inline ? 'inline' : (updated.packType || 'regular')
  await ctx.db.User.updateOne({ _id: updated.owner }, { $set: { [`packsCount.${countType}`]: 0 } })
  if (ctx.session.userInfo.packsCount) ctx.session.userInfo.packsCount[countType] = 0

  // Hiding the selected pack: switch to the most recent visible pack of the
  // same kind, so the next photo doesn't go into a pack the user put away.
  // persistUserIfDirty (bot/middleware.js) saves the change.
  const selected = ctx.session.userInfo.stickerSet
  if (hide && selected && String(selected._id || selected) === String(updated._id)) {
    const next = await ctx.db.StickerSet.findOne({
      _id: { $ne: updated._id },
      owner: ctx.session.userInfo.id,
      create: true,
      hide: { $ne: true },
      deleted: { $ne: true },
      ...(updated.inline
        ? { inline: true }
        : { inline: { $ne: true }, packType: updated.packType === 'custom_emoji' ? 'custom_emoji' : { $in: ['regular', null] } })
    }).sort({ updatedAt: -1 })

    ctx.session.userInfo.stickerSet = next || null
  }

  await ctx.answerCbQuery(ctx.i18n.t(hide ? 'callback.pack.answerCbQuer.hidden' : 'callback.pack.answerCbQuer.restored'))
  await editPackMenu(ctx, updated)
}
