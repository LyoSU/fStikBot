const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')

const composer = new Composer()

composer.action(/admin:pack:edit/, (ctx) => ctx.scene.enter('adminPackFind'))

composer.action(/admin:pack/, async (ctx, next) => {
  const resultText = 'Admin pack'

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('Edit pack', 'admin:pack:edit')],
    [Markup.callbackButton('Back', 'admin:back')]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

module.exports = composer
