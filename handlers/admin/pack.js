const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')

const composer = new Composer()

composer.action(/admin:pack:edit/, (ctx) => ctx.scene.enter('adminPackFind'))

composer.action(/admin:pack/, async (ctx, next) => {
  const resultText = ctx.i18n.t('admin.pack.info')

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton(ctx.i18n.t('admin.pack.edit_button'), 'admin:pack:edit')],
    [Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

module.exports = composer
