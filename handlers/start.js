const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.info', {
    name: userName(ctx.from)
  }), Markup.keyboard([
    [
      ctx.i18n.t('cmd.start.btn.packs')
    ],
    [
      ctx.i18n.t('cmd.start.btn.animpacks')
    ],
    [
      ctx.i18n.t('cmd.start.btn.new')
    ],
    [
      ctx.i18n.t('cmd.start.btn.donate')
    ]
  ]).resize().extra())
}
