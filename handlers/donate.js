const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const { match } = require('telegraf-i18n')

const composer = new Composer()

const donateMenu = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.callbackButton(ctx.i18n.t('donate.btn.donate'), 'donate:topup')]
    ])
  })
}

composer.hears(['/donate', '/boost', '/start boost', match('cmd.start.btn.club')], donateMenu)

composer.action('donate:topup', async (ctx) => {
  return ctx.scene.enter('donate')
})

composer.action(/donate:(\d+)/, async (ctx) => {
  return ctx.scene.enter('donate', {
    amount: ctx.match[1]
  })
})

module.exports = composer
