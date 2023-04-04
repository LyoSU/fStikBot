const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.help', {
    name: userName(ctx.from)
  }), Markup.removeKeyboard().extra({ disable_web_page_preview: true }))
}
