
const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.club', {
    titleSuffix: ` :: @${ctx.options.username}`
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.urlButton('Telegram Donate', 'https://t.me/LyBlog/553')],
      [Markup.urlButton('Other', 'https://donate.lyo.su')]
    ])
  })
}
