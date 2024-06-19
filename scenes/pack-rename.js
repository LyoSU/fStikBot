const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  escapeHTML,
  countUncodeChars,
  substrUnicode
} = require('../utils')

const packRename = new Scene('packRename')

packRename.enter(async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    await ctx.answerCbQuery(ctx.i18n.t('Access denied'), true)
    return ctx.scene.leave()
  }

  ctx.session.userInfo.stickerSet = stickerSet

  const linkPrefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

  await ctx.replyWithHTML(ctx.i18n.t('scenes.rename.enter_name', {
    title: escapeHTML(stickerSet.title),
    link: `${linkPrefix}${stickerSet.name}`
  }), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

packRename.on('text', async (ctx) => {
  const { stickerSet } = ctx.session.userInfo

  const titleSuffix = stickerSet.boost ? '' : ` :: @${ctx.options.username}`
  const charTitleMax = stickerSet.boost ? ctx.config.premiumCharTitleMax : ctx.config.charTitleMax

  let newTitle = ctx.message.text

  if (countUncodeChars(newTitle) > charTitleMax) {
    newTitle = substrUnicode(newTitle, 0, charTitleMax)
  }

  newTitle += titleSuffix

  const result = await ctx.telegram.callApi('setStickerSetTitle', {
    name: stickerSet.name,
    title: newTitle
  })

  if (!result) {
    return ctx.replyWithHTML(ctx.i18n.t('error.unknown'))
  }

  stickerSet.title = newTitle
  await stickerSet.save()

  const linkPrefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

  const text = ctx.i18n.t('scenes.rename.success', {
    title: escapeHTML(stickerSet.title),
    link: `${linkPrefix}${stickerSet.name}`
  }) + (titleSuffix ? ('\n' + ctx.i18n.t('scenes.rename.boost_notice', {
    titleSuffix: escapeHTML(titleSuffix)
  })) : '')

  await ctx.replyWithHTML(text, {
    reply_markup: Markup.removeKeyboard()
  })

  ctx.scene.leave()
})

module.exports = packRename
