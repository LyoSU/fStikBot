const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const freekassa = require('@alex-kondakov/freekassa')

const exchangeRate = {
  RUB: 90,
  USD: 1,
  UAH: 35
}

const donateScene = new Scene('donate')

donateScene.enter(async (ctx) => {
  await ctx.answerCbQuery()

  await ctx.editMessageText(ctx.i18n.t('donate.topup'), {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.callbackButton('10 Credits', 'donate:10'),
        Markup.callbackButton('20 Credits', 'donate:20')
      ],
      [
        Markup.callbackButton('50 Credits', 'donate:50'),
        Markup.callbackButton('100 Credits', 'donate:100')
      ]
    ])
  })
})

const donate = async (ctx) => {
  const amount = parseInt(ctx?.message?.text) || ( ctx?.match && parseInt(ctx?.match[1]))

  if (isNaN(amount)) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount < 5) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  const price = amount / 5
  const priceUAH = (price * exchangeRate.UAH).toFixed(2)
  const priceRUB = (price * exchangeRate.RUB).toFixed(2)

  const comment = `@${ctx.from.username} (${ctx.from.id}) for ${amount} credit`

  let ruLink

  // if locale is ru
  if (ctx.session.userInfo.locale === 'ru' || ctx.from.language_code === 'ru') {
    const freekassaPayment = freekassa.init()

    freekassaPayment.secret1 = process.env.FREEKASSA_SECRET1
    freekassaPayment.secret2 = process.env.FREEKASSA_SECRET2
    freekassaPayment.shopId = process.env.FREEKASSA_SHOP_ID
    freekassaPayment.paymentId = comment + ' (' + new Date().getTime() + ')'
    freekassaPayment.amount = priceRUB
    freekassaPayment.currency = 'RUB'
    freekassaPayment.description = comment
    freekassaPayment.email = process.env.FREEKASSA_EMAIL

    freekassaPayment.sign()

    ruLink = await freekassaPayment.create()
  }

  const message = ctx.i18n.t('donate.paymenu', {
    amount,
    price
  })

  const repltMarkup =  Markup.inlineKeyboard([
    [Markup.urlButton(`Оплата — ${priceRUB}₽`, ruLink, !ruLink)],
    [Markup.urlButton(`Card, Google Pay, Apple Pay — ${price}$ / ${priceUAH}₴`, `https://send.monobank.ua/jar/6RwLN9a9Yj?a=${priceUAH}&t=${encodeURI(comment)}`)],
  ])

  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery()
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: repltMarkup
    })
  } else {
    await ctx.replyWithHTML(message, {
      reply_markup: repltMarkup
    })
  }

  return ctx.scene.leave()
}

donateScene.on('text', donate)
donateScene.action(/donate:(\d+)/, donate)

module.exports = donateScene
