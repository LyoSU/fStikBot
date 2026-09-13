const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2]).catch(() => null)

  if (!stickerSet) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
  }

  let answerCbQuer = ''

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  const wasHidden = stickerSet.hide === true
  const newHideValue = !wasHidden
  const updatedSet = await ctx.db.StickerSet.findOneAndUpdate(
    { _id: stickerSet._id },
    { $set: { hide: newHideValue } },
    { new: true }
  )

  // Update user's pack count
  const countField = stickerSet.inline
    ? 'packsCount.inline'
    : `packsCount.${stickerSet.packType || 'regular'}`
  await ctx.db.User.updateOne(
    { _id: stickerSet.owner },
    { $inc: { [countField]: wasHidden ? 1 : -1 } }
  )

  if (updatedSet.hide === true) {
    answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.hidden')

    // Only when the hidden pack IS the selected one: switch to the most
    // recent visible pack of the same kind. This used to run for any hidden
    // pack and could pick the inline or an emoji pack, so the next photo
    // silently went into the wrong set.
    const selected = ctx.session.userInfo.stickerSet
    const selectedId = selected?._id || selected
    if (selectedId && String(selectedId) === String(updatedSet._id)) {
      const userSet = await ctx.db.StickerSet.findOne({
        _id: { $ne: updatedSet._id },
        owner: ctx.session.userInfo.id,
        create: true,
        hide: { $ne: true },
        deleted: { $ne: true },
        ...(updatedSet.inline
          ? { inline: true }
          : { inline: { $ne: true }, packType: updatedSet.packType === 'custom_emoji' ? 'custom_emoji' : { $in: ['regular', null] } })
      }).sort({ updatedAt: -1 })

      // persistUserIfDirty (bot/middleware.js) saves the change.
      if (userSet) ctx.session.userInfo.stickerSet = userSet
    }
  } else {
    answerCbQuer = ctx.i18n.t('callback.pack.answerCbQuer.restored')
  }
  await ctx.answerCbQuery(answerCbQuer)

  const hideData = `hide_pack:${ctx.match[2]}`
  const deleteData = `delete_pack:${ctx.match[2]}`
  const hideText = ctx.i18n.t(updatedSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide')

  const existingRows = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard

  let inlineKeyboard = []

  if (Array.isArray(existingRows) && existingRows.length > 0) {
    // Keep the pack menu as it is and only swap the hide/restore button. The
    // old code rebuilt the keyboard from scratch, so one tap on "Hide" reduced
    // the whole pack menu (use pack / boost / rename / frame / catalog / …) to
    // one or two buttons.
    inlineKeyboard = existingRows
      .map((row) => row
        .filter((btn) => btn.callback_data !== deleteData)
        .map((btn) => (btn.callback_data === hideData ? { ...btn, text: hideText } : btn)))
      .filter((row) => row.length > 0)
  } else {
    inlineKeyboard.push([Markup.callbackButton(hideText, hideData)])
  }

  if (updatedSet.hide === true) {
    inlineKeyboard.unshift([
      { ...Markup.callbackButton(ctx.i18n.t('callback.pack.btn.delete'), deleteData), style: 'danger' }
    ])
  }

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: inlineKeyboard })
  } catch (err) {
    // Updating reply markup is best-effort UI sync. The DB state is already
    // committed and the user got a toast, so silent log is fine here.
    console.error('Failed to update pack visibility markup:', err.message)
  }
}
