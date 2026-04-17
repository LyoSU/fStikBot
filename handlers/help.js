const Markup = require('telegraf/markup')
const { replyOrEditBanner } = require('../banners')

module.exports = async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.urlButton(ctx.i18n.t('cmd.guide.btn.open'), 'https://fstik.app/guides')]
  ])

  await replyOrEditBanner(ctx, 'help', ctx.i18n.t('cmd.guide.web'), {
    reply_markup: keyboard
  })
}
