const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.urlButton(ctx.i18n.t('cmd.guide.btn.open'), 'https://fstik.app/guides')]
  ])

  await ctx.replyWithHTML(ctx.i18n.t('cmd.guide.web'), {
    reply_markup: keyboard,
    disable_web_page_preview: true
  })
}
