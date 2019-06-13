
const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  if (ctx.updateType === 'callback_query') {
    ctx.answerCbQuery()

    let amount = ctx.match[2] || 0

    if (amount < 100) amount = 100
    amount *= 100

    const invoice = {
      provider_token: process.env.PROVIDER_TOKEN,
      start_parameter: 'donate',
      title: ctx.i18n.t('cmd.donate.pay.title', {
        botUsername: ctx.options.username,
      }),
      description: ctx.i18n.t('cmd.donate.pay.description'),
      currency: 'rub',
      prices: [
        { label: `Donate @${ctx.options.username}`, amount },
      ],
      payload: {},
    }

    ctx.replyWithInvoice(invoice, Markup.inlineKeyboard([
      Markup.payButton(ctx.i18n.t('cmd.donate.pay.btn.buy')),
    ]).extra())
  }
  else if (ctx.updateSubTypes[0] === 'successful_payment') {
    ctx.replyWithHTML(ctx.i18n.t('cmd.donate.pay.successful'))

    const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })

    console.log()
    user.premium = true
    user.donates.push(ctx.message.successful_payment)
    user.save()
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('cmd.donate.info', {
      titleSuffix: ` by @${ctx.options.username}`,
    }), {
      reply_markup: Markup.inlineKeyboard([
        [

          Markup.callbackButton('☕️ 100 RUB', 'donate:100'),
          Markup.callbackButton('🍔 150 RUB', 'donate:200'),
          Markup.callbackButton('🍰 300 RUB', 'donate:300'),
        ],
        [
          Markup.callbackButton('🍱 500 RUB', 'donate:500'),
          Markup.callbackButton('❤️ 1000 RUB', 'donate:1000'),
        ],
      ]),
    })
  }
}
