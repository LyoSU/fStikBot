const Markup = require('telegraf/markup')

const getGuideKeyboard = (ctx) => {
  return Markup.inlineKeyboard([
    [Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.create'), 'guide:create')],
    [Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.manage'), 'guide:manage')],
    [Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.catalog'), 'guide:catalog')],
    [Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.boost'), 'guide:boost')],
    [Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.problems'), 'guide:problems')]
  ])
}

const getSectionKeyboard = (ctx, section) => {
  const keyboard = [[Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.back'), 'guide:menu')]]

  if (section === 'create') {
    keyboard.unshift([Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')])
  } else if (section === 'manage') {
    keyboard.unshift([Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null')])
  } else if (section === 'catalog') {
    keyboard.unshift([Markup.callbackButton(ctx.i18n.t('cmd.start.commands.catalog'), 'search_catalog')])
  } else if (section === 'boost') {
    keyboard.unshift([Markup.callbackButton(ctx.i18n.t('cmd.start.commands.donate'), 'donate')])
  }

  return Markup.inlineKeyboard(keyboard)
}

module.exports = async (ctx) => {
  const section = ctx.match?.[1] || 'menu'

  let text
  let keyboard

  if (section === 'menu') {
    text = ctx.i18n.t('cmd.guide.menu')
    keyboard = getGuideKeyboard(ctx)
  } else if (section === 'boost') {
    text = ctx.i18n.t('cmd.guide.boost', {
      titleSuffix: ctx.config.titleSuffix || 'by @fStikBot'
    })
    keyboard = getSectionKeyboard(ctx, section)
  } else {
    text = ctx.i18n.t(`cmd.guide.${section}`)
    keyboard = getSectionKeyboard(ctx, section)
  }

  if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      parse_mode: 'HTML'
    }).catch(() => {})
  } else {
    await ctx.replyWithHTML(text, { reply_markup: keyboard })
  }
}
