const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.info', {
    name: userName(ctx.from)
  }), Markup.keyboard([
    [
      ctx.i18n.t('cmd.start.btn.packs'), ctx.i18n.t('cmd.start.btn.inline')
    ],
    [
      ctx.i18n.t('cmd.start.btn.video'), ctx.i18n.t('cmd.start.btn.anim')
    ],
    [
      ctx.i18n.t('cmd.start.btn.club')
    ]
  ]).resize().extra({ disable_web_page_preview: true }))
}
