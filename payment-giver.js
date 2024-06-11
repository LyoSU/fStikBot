const mongoose = require('mongoose')
const { WalletPaySDK } = require('wallet-pay-sdk')
const {
  db
} = require('./database/')
const I18n = require('telegraf-i18n')
const Telegram = require('telegraf/telegram')

const walletPay = new WalletPaySDK({
  apiKey: process.env.WALLETPAY_API_KEY,
  timeoutSeconds: 10800
})

const telegram = new Telegram(process.env.BOT_TOKEN)

const i18n = new I18n({
  directory: `${__dirname}/locales`,
  defaultLanguage: 'en'
})

const getWalletPayOrders = async () => {
  const total = await walletPay.getOrderAmount()
  const offset = total.data.totalAmount - 100

  const result = await walletPay.getOrderList({
    offset: offset > 0 ? offset : 0,
    count: 100
  })

  return result.data.items.filter((item) => item.status === 'PAID')
}

const giveCredit = async () => {
  let wpOrders = []

  if (process.env.WALLETPAY_API_KEY) {
    wpOrders = await getWalletPayOrders()
  }

  const orders = [...wpOrders].map((order) => (
    order.merchant_order_id || order.externalId
  ))

  for (const orderId of orders) {
    if (!mongoose.Types.ObjectId.isValid(orderId)) continue

    const payment = await db.Payment.findOne({
      _id: mongoose.Types.ObjectId(orderId),
      status: 'pending'
    })

    if (!payment) continue

    const user = await db.User.findById(payment.user)

    if (!user) continue

    const credit = parseInt(payment.amount)

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
}

setInterval(giveCredit, 1000 * 60 * 5)
