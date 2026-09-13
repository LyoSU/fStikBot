const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  escapeHTML,
  countUncodeChars,
  substrUnicode
} = require('../utils')

const packRename = new Scene('packRename')

const linkFor = (ctx, stickerSet) => {
  const prefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix
  return `${prefix}${stickerSet.name}`
}

// Loads the pack and checks the caller owns it. Null on a bad id or a pack
// that isn't theirs.
const loadOwnedPack = async (ctx, id) => {
  if (!id) return null
  const stickerSet = await ctx.db.StickerSet.findById(id).catch(() => null)
  if (!stickerSet || String(stickerSet.owner) !== String(ctx.session.userInfo._id)) return null
  return stickerSet
}

packRename.enter(async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2]).catch(() => null)

  if (!stickerSet) {
    await ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
    return ctx.scene.leave()
  }

  if (String(stickerSet.owner) !== String(ctx.session.userInfo._id)) {
    await ctx.answerCbQuery(ctx.i18n.t('error.access_denied'), true)
    return ctx.scene.leave()
  }

  // The target lives in the scene's own state. It used to be written into
  // userInfo.stickerSet, which silently switched the user's selected pack to
  // the one being renamed — and, if that write didn't persist before the next
  // update, renamed the previously selected pack instead.
  ctx.session.scene = { ...(ctx.session.scene || {}), rename: { id: String(stickerSet._id) } }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.rename.enter_name', {
    title: escapeHTML(stickerSet.title),
    link: linkFor(ctx, stickerSet)
  }), {
    reply_markup: Markup.keyboard([
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})

packRename.on('text', async (ctx) => {
  const stickerSet = await loadOwnedPack(ctx, ctx.session.scene?.rename?.id)

  if (!stickerSet) {
    await ctx.scene.leave()
    return ctx.replyWithHTML(ctx.i18n.t('error.access_denied'), {
      reply_markup: Markup.removeKeyboard()
    })
  }

  const titleSuffix = stickerSet.boost ? '' : ` :: @${ctx.options.username}`
  const charTitleMax = stickerSet.boost ? ctx.config.premiumCharTitleMax : ctx.config.charTitleMax

  let newTitle = ctx.message.text

  if (countUncodeChars(newTitle) > charTitleMax) {
    newTitle = substrUnicode(newTitle, 0, charTitleMax)
  }

  newTitle += titleSuffix

  try {
    await ctx.telegram.callApi('setStickerSetTitle', {
      name: stickerSet.name,
      title: newTitle
    })
  } catch (error) {
    const description = error?.description || error?.message || ''
    if (description.includes('STICKERSET_INVALID')) {
      await ctx.scene.leave()
      return ctx.replyWithHTML(ctx.i18n.t('error.stickerset_invalid'), {
        reply_markup: Markup.removeKeyboard()
      })
    }
    // Anything else (e.g. a title Telegram rejects) — stay in the scene so the
    // user can simply send another title.
    return ctx.replyWithHTML(ctx.i18n.t('error.unknown'))
  }

  stickerSet.title = newTitle
  await stickerSet.save()

  const text = ctx.i18n.t('scenes.rename.success', {
    title: escapeHTML(stickerSet.title),
    link: linkFor(ctx, stickerSet)
  }) + (titleSuffix
    ? ('\n' + ctx.i18n.t('scenes.rename.boost_notice', {
        titleSuffix: escapeHTML(titleSuffix)
      }))
    : '')

  await ctx.scene.leave()
  return ctx.replyWithHTML(text, {
    reply_markup: Markup.removeKeyboard()
  })
})

module.exports = packRename
