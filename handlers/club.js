
const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.club', {
    titleSuffix: ` :: @${ctx.options.username}`
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.urlButton('Bank card', 'https://send.monobank.ua/jar/6RwLN9a9Yj')],
      [Markup.urlButton('Other', 'https://donate.lyo.su')]
    ])
  })
}
