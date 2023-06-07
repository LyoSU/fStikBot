const mongoose = require('mongoose')
const Freekassa = require('@alex-kondakov/freekassa')
const {
  db
} = require('./database/')
const I18n = require('telegraf-i18n')
const Telegram = require('telegraf/telegram')

const telegram = new Telegram(process.env.BOT_TOKEN)

const i18n = new I18n({
  directory: `${__dirname}/locales`,
  defaultLanguage: 'en'
})

const getFreeKassaOrders = async () => {
  const freekassa = Freekassa.init()
  freekassa.shopId = process.env.FREEKASSA_SHOP_ID
  freekassa.key = process.env.FREEKASSA_API_KEY
  freekassa.orderCount = 10
  freekassa.orderStatus = 1

  const result = await freekassa.orders()

  return result.orders
}

const giveCredit = async () => {
  const orders = await getFreeKassaOrders()

  for (const order of orders) {
    if (!mongoose.Types.ObjectId.isValid(order.merchant_order_id)) continue

    const payment = await db.Payment.findOne({
      _id: mongoose.Types.ObjectId(order.merchant_order_id),
      status: 'pending'
    })

    if (!payment) continue

    const user = await db.User.findById(payment.user)

    if (!user) continue

    const credit = parseInt(payment.amount) * 5

    user.balance += credit
    payment.status = 'paid'

    await user.save()
    await payment.save()

    await telegram.sendMessage(user.telegram_id, i18n.t(user.locale, 'donate.update', {
      amount: credit,
      balance: user.balance
    }), {
      parse_mode: 'HTML'
    })
  }

  setTimeout(giveCredit, 1000 * 5)
}

giveCredit()
