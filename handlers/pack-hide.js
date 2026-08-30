const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

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

    const userSet = await ctx.db.StickerSet.findOne({
      owner: ctx.session.userInfo.id,
      create: true,
      hide: false
    }).sort({ updatedAt: -1 })

    if (userSet) {
      ctx.session.userInfo.stickerSet = userSet
      await ctx.session.userInfo.save()
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
