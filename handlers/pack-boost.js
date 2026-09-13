const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const rateLimit = require('telegraf-ratelimit')
const escapeHTML = require('../utils/html-escape')
const packLink = require('../utils/pack-link')
const { editPackMenu, isOwner } = require('./pack-menu')

const composer = new Composer()

// Every boost screen edits the pack menu it was opened from and returns to it:
// "No" used to delete the menu and "Yes" left text without buttons, although
// the success text sends the user to "Rename" in that very menu.
const loadOwnedPack = async (ctx, id) => {
  const stickerSet = await ctx.db.StickerSet.findById(id).catch(() => null)

  if (!stickerSet) {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.error.notFound'), true)
    return null
  }
  if (!isOwner(ctx, stickerSet)) {
    await ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
    return null
  }
  return stickerSet
}

composer.action(/^boost:(yes|no):(.+)$/, rateLimit({
  window: 3000,
  limit: 1,
  onLimitExceeded: (ctx) => ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.too_fast'), true)
}), async (ctx) => {
  const stickerSet = await loadOwnedPack(ctx, ctx.match[2])
  if (!stickerSet) return

  if (ctx.match[1] === 'no') {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.canceled'))
    return editPackMenu(ctx, stickerSet)
  }

  if (stickerSet.boost) {
    await ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)
    return editPackMenu(ctx, stickerSet)
  }

  // Charge first, atomically and only when the balance covers it — the
  // session balance can be stale.
  const charged = await ctx.db.User.updateOne(
    { _id: ctx.session.userInfo._id, balance: { $gte: 1 } },
    { $inc: { balance: -1 } }
  )
  if (!charged.modifiedCount) {
    return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.not_enough_credits'), true)
  }

  const boosted = await ctx.db.StickerSet.updateOne(
    { _id: stickerSet._id, boost: { $ne: true } },
    { $set: { boost: true } }
  )
  if (!boosted.modifiedCount) {
    // Someone boosted it in the meantime — give the credit back.
    await ctx.db.User.updateOne({ _id: ctx.session.userInfo._id }, { $inc: { balance: 1 } })
    return ctx.answerCbQuery(ctx.i18n.t('scenes.boost.error.already_boosted'), true)
  }

  ctx.session.userInfo.balance -= 1
  stickerSet.boost = true

  await ctx.answerCbQuery()
  return editPackMenu(ctx, stickerSet, {
    notice: ctx.i18n.t('scenes.boost.success', {
      title: escapeHTML(stickerSet.title),
      link: packLink(stickerSet),
      titleSuffix: escapeHTML(` :: @${ctx.options.username}`)
    })
  })
})

// pack_menu:<id> — back to the pack menu from a screen that replaced it.
composer.action(/^pack_menu:(.+)$/, async (ctx) => {
  const stickerSet = await loadOwnedPack(ctx, ctx.match[1])
  if (!stickerSet) return
  await ctx.answerCbQuery()
  return editPackMenu(ctx, stickerSet)
})

composer.action(/^boost:(.+)$/, async (ctx) => {
  const stickerSet = await loadOwnedPack(ctx, ctx.match[1])
  if (!stickerSet) return
  await ctx.answerCbQuery()

  const { balance } = ctx.session.userInfo
  const back = Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.no'), `pack_menu:${stickerSet._id}`)

  // With no credits a "Boost" button could only fail; offer the purchase.
  const buttons = balance >= 1
    ? [
        { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.yes'), `boost:yes:${stickerSet._id}`), style: 'success' },
        { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.no'), `boost:no:${stickerSet._id}`), style: 'danger' }
      ]
    : [
        { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.buy'), 'donate:topup'), style: 'success' },
        back
      ]

  const text = ctx.i18n.t('scenes.boost.sure', {
    title: escapeHTML(stickerSet.title),
    link: packLink(stickerSet),
    balance
  })
  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: Markup.inlineKeyboard([buttons])
  }

  return ctx.editMessageText(text, extra).catch(() => ctx.replyWithHTML(text, extra))
})

module.exports = composer
