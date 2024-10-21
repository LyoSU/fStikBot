const fs = require('fs')
const path = require('path')
const got = require('got')
const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const CryptoPay = require('@foile/crypto-pay-api')
const { escapeHTML: escape } = require('../../utils')

const cryptoPay = new CryptoPay.CryptoPay(process.env.CRYPTOPAY_API_KEY)

const i18n = new I18n({
  directory: `${__dirname}/../../locales`,
  defaultLanguage: 'en',
  sessionName: 'session',
  useSession: true,
  allowMissing: false,
  skipPluralize: true
})

const adminType = ['messaging', 'pack']

const composer = new Composer()

// Middleware to check admin rights
const checkAdminRight = (ctx, next) => {
  if (ctx.config.mainAdminId === ctx.from.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.length > 0)) {
    return next()
  }
  return ctx.replyWithHTML('🚫 You are not authorized to access the admin panel.')
}

// Main admin panel menu
const displayAdminPanel = async (ctx) => {
  const resultText = `
🔐 <b>Admin Panel</b>

Welcome to the admin control center. Please select an option:

🔹 User Management
🔹 Financial Operations
🔹 Transaction History
🔹 System Settings
`

  const inlineKeyboard = [
    [Markup.callbackButton('👥 User Management', 'admin:user_management')],
    [Markup.callbackButton('💰 Financial Operations', 'admin:financial_ops')],
    [Markup.callbackButton('📊 Transaction History', 'admin:transactions')],
    ...adminType
      .filter(type => ctx.config.mainAdminId === ctx.from.id || ctx.session.userInfo.adminRights.includes(type))
      .map(type => [Markup.callbackButton(`⚙️ Admin ${type}`, `admin:${type}`)]),
  ]

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  const messageMethod = ctx.callbackQuery ? 'editMessageText' : 'replyWithHTML'
  await ctx[messageMethod](resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(error => console.error('Error displaying admin panel:', error))
}

// User Management submenu
const displayUserManagement = async (ctx) => {
  const resultText = `
👥 <b>User Management</b>

Select an action:

🔹 Ban/Unban User
🔹 Set Premium Credits
🔹 View User Info
`

  const inlineKeyboard = [
    [Markup.callbackButton('🚫 Ban/Unban User', 'admin:user:ban')],
    [Markup.callbackButton('⭐️ Set Premium Credits', 'admin:user:premium')],
    [Markup.callbackButton('ℹ️ View User Info', 'admin:user:info')],
    [Markup.callbackButton('🔙 Back to Admin Panel', 'admin:main')]
  ]

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(error => console.error('Error displaying user management:', error))
}

// Financial Operations submenu
const displayFinancialOps = async (ctx) => {
  const resultText = `
💰 <b>Financial Operations</b>

Select an action:

🔹 Refund Payment
🔹 Add/Remove Credits
🔹 View Payment History
`

  const inlineKeyboard = [
    [Markup.callbackButton('💸 Refund Payment', 'admin:finance:refund')],
    [Markup.callbackButton('💳 Add/Remove Credits', 'admin:finance:credits')],
    [Markup.callbackButton('📜 View Payment History', 'admin:finance:history')],
    [Markup.callbackButton('🔙 Back to Admin Panel', 'admin:main')]
  ]

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(error => console.error('Error displaying financial operations:', error))
}

// Transaction History submenu
const displayTransactionHistory = async (ctx) => {
  const resultText = `
📊 <b>Transaction History</b>

View transaction history:

🔹 Crypto Transactions
🔹 MonoBank Transactions
🔹 Stars Transactions
`

  const inlineKeyboard = [
    [Markup.callbackButton('🪙 Crypto Transactions', 'admin:history:crypto')],
    [Markup.callbackButton('🏦 MonoBank Transactions', 'admin:history:mono')],
    [Markup.callbackButton('⭐️ Stars Transactions', 'admin:history:stars')],
    [Markup.callbackButton('🔙 Back to Admin Panel', 'admin:main')]
  ]

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(error => console.error('Error displaying transaction history:', error))
}

// Ban/unban user
const toggleUserBan = async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML('Please enter the user ID or username to ban/unban:')
  ctx.session.awaitingInput = 'ban_user'
}

// Set user premium credits
const setPremiumCredits = async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML('Please enter the user ID or username and the amount of credits to add/remove (e.g., "123456789 100" or "@username -50"):')
  ctx.session.awaitingInput = 'set_premium'
}

// Refund payment
const initiateRefund = async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML('Please enter the payment ID to refund:')
  ctx.session.awaitingInput = 'refund_payment'
}

// Get last crypto transactions
const getLastCryptoTransactions = async (ctx) => {
  await ctx.answerCbQuery()
  try {
    const result = await cryptoPay.getInvoices({ status: 'paid', count: 10 })
    const resultText = result.items.map((item, index) =>
      `${index + 1}. <b>${escape(item.description)}</b>\n   💰 ${item.amount} ${item.asset}\n   🕒 ${new Date(item.paid_at).toLocaleString()}\n`
    ).join('\n')

    await ctx.editMessageText(`<b>📊 Last 10 Crypto Transactions</b>\n\n${resultText}`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([[Markup.callbackButton('🔙 Back', 'admin:transactions')]])
    })
  } catch (error) {
    console.error('Error fetching crypto transactions:', error)
    await ctx.answerCbQuery('Failed to fetch crypto transactions. Please try again later.', true)
  }
}

// Get last MonoBank transactions
const getLastMonoTransactions = async (ctx) => {
  await ctx.answerCbQuery()
  try {
    const result = await got(`https://api.monobank.ua/personal/statement/${process.env.MONO_ACCOUNT}/${Math.floor(Date.now() / 1000) - 86400 * 3}`, {
      headers: { 'X-Token': process.env.MONO_TOKEN }
    }).json()

    const resultText = result.slice(0, 10).map((item, index) =>
      `${index + 1}. <b>${escape(item.description)}</b>\n   💰 ${item.amount / 100} ${item.currencyCode}\n   💬 <code>${escape(item.comment)}</code>\n   🕒 ${new Date(item.time * 1000).toLocaleString()}\n`
    ).join('\n')

    await ctx.editMessageText(`<b>📊 Last 10 MonoBank Transactions</b>\n\n${resultText}`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([[Markup.callbackButton('🔙 Back', 'admin:transactions')]])
    })
  } catch (error) {
    console.error('Error fetching MonoBank transactions:', error)
    await ctx.answerCbQuery('Failed to fetch MonoBank transactions. Please try again later.', true)
  }
}

// Get stars transactions
const getStarsTransactions = async (ctx) => {
  await ctx.answerCbQuery()
  try {
    let transactions = []
    let offset = 0
    const limit = 100

    while (true) {
      const result = await ctx.tg.callApi('getStarTransactions', { limit, offset })
      if (!result.transactions || result.transactions.length === 0) break
      transactions.push(...result.transactions.filter(item => item.source))
      if (result.transactions.length < limit) break
      offset += limit
    }

    transactions.sort((a, b) => b.date - a.date)

    const csvContent = [
      'Date,Amount,USD Amount,User Name,User ID',
      ...transactions.map(item => 
        `"${new Date(item.date * 1000).toLocaleString()}",${item.amount},${(item.amount * 0.013).toFixed(2)},"${item?.source?.user?.first_name?.replace(/"/g, '""') || ''}",${item.source?.user?.id || ''}`
      )
    ].join('\n');

    await ctx.replyWithDocument({ source: Buffer.from(csvContent, 'utf-8'), filename: 'stars_transactions.csv' })

    const last20Transactions = transactions.slice(0, 20)

    const resultText = last20Transactions.map((item, index) =>
      `${index + 1}. <b>${item.amount} stars</b> ($${(item.amount * 0.013).toFixed(2)})\n   👤 From: <a href="tg://user?id=${item.source.user.id}">${escape(item.source.user.first_name)}</a>\n   🕒 ${new Date(item.date * 1000).toLocaleString()}\n`
    ).join('\n')

    await ctx.editMessageText(`<b>📊 Last 20 Stars Transactions</b>\n\n${resultText}\n\nA CSV file with all transactions has been sent.`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([[Markup.callbackButton('🔙 Back', 'admin:transactions')]])
    })
  } catch (error) {
    console.error('Error fetching stars transactions:', error)
    await ctx.answerCbQuery('Failed to fetch stars transactions. Please try again later.', true)
  }
}

// Handle user input for various operations
composer.on('text', async (ctx, next) => {
  if (!ctx.session.awaitingInput) return next()

  switch (ctx.session.awaitingInput) {
    case 'ban_user':
      await handleBanUser(ctx, ctx.message.text)
      break
    case 'set_premium':
      await handleSetPremium(ctx, ctx.message.text)
      break
    case 'refund_payment':
      await handleRefundPayment(ctx, ctx.message.text)
      break
    case 'view_user_info':
      await handleViewUserInfo(ctx, ctx.message.text)
      break
  }

  ctx.session.awaitingInput = null
})

// Handle ban/unban user
const handleBanUser = async (ctx, input) => {
  const user = await findUser(ctx, input)
  if (!user) return ctx.replyWithHTML('❌ User not found. Please check the ID or username and try again.')

  user.banned = !user.banned
  await user.save()

  await ctx.replyWithHTML(`User ${escape(user.telegram_id)} (${escape(user.username)}) banned: ${user.banned ? 'yes' : 'no'}`)
}

// Handle set premium credits
const handleSetPremium = async (ctx, input) => {
  const [userId, creditStr] = input.split(' ')
  const credit = parseInt(creditStr)

  if (isNaN(credit)) {
    return ctx.replyWithHTML('❌ Invalid credit amount. Please enter a valid number.')
  }

  const user = await findUser(ctx, userId)
  if (!user) return ctx.replyWithHTML('❌ User not found. Please check the ID or username and try again.')

  user.balance += credit
  await user.save()

  await ctx.replyWithHTML(`User ${escape(user.telegram_id)} (${escape(user.username)}) balance updated to ${user.balance} credits (added ${credit} credits)`)

  if (credit !== 0) {
    await ctx.telegram.sendMessage(user.telegram_id, i18n.t(user.locale, 'donate.update', {
      amount: credit,
      balance: user.balance
    }), { parse_mode: 'HTML' })
  }
}

// Handle refund payment
const handleRefundPayment = async (ctx, paymentId) => {
  const payment = await ctx.db.Payment.findOne({
    "resultData.telegram_payment_charge_id": paymentId
  })

  if (!payment) return ctx.replyWithHTML('❌ Payment not found.')

  const refundUser = await ctx.db.User.findOne({ _id: payment.user })
  if (!refundUser) return ctx.replyWithHTML('❌ User not found.')

  try {
    await ctx.telegram.callApi('refundStarPayment', {
      user_id: refundUser.telegram_id,
      telegram_payment_charge_id: paymentId
    })

    refundUser.balance -= payment.amount
    await refundUser.save()

    payment.status = 'refunded'
    await payment.save()

    await ctx.replyWithHTML(`✅ Payment ${escape(paymentId)} refunded successfully.`)
  } catch (error) {
    console.error('Refund failed:', error)
    await ctx.replyWithHTML('❌ Refund failed. Please check the logs for more information.')
  }
}

// Helper function to find user by ID or username
const findUser = async (ctx, input) => {
  return await ctx.db.User.findOne({
    $or: [{ telegram_id: parseInt(input) || 0 }, { username: input }]
  })
}

// View user info
const viewUserInfo = async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML('Please enter the user ID or username to view info:')
  ctx.session.awaitingInput = 'view_user_info'
}

// Handle viewing user info
const handleViewUserInfo = async (ctx, input) => {
  const user = await findUser(ctx, input)
  if (!user) return ctx.replyWithHTML('❌ User not found. Please check the ID or username and try again.')

  const userInfo = `
👤 <b>User Information</b>

🆔 Telegram ID: ${escape(user.telegram_id)}
👤 Name: ${escape(user.first_name)} ${user.last_name ? escape(user.last_name) : ''}
🏷 Username: ${user.username ? '@' + escape(user.username) : 'Not set'}
💰 Balance: ${user.balance} credits
🌍 Locale: ${user.locale || 'Not set'}
🚫 Banned: ${user.banned ? 'Yes' : 'No'}
🔒 Blocked: ${user.blocked ? 'Yes' : 'No'}
👑 Admin Rights: ${user.adminRights.length > 0 ? user.adminRights.join(', ') : 'None'}
🛡 Moderator: ${user.moderator ? 'Yes' : 'No'}
🚷 Public Ban: ${user.publicBan ? 'Yes' : 'No'}

📦 Sticker Set: ${user.stickerSet ? `<code>${escape(user.stickerSet)}</code>` : 'Not set'}
🔠 Inline Sticker Set: ${user.inlineStickerSet ? `<code>${escape(user.inlineStickerSet)}</code>` : 'Not set'}
📊 Inline Type: ${user.inlineType || 'Not set'}
📰 News Subscribed: ${user.newsSubscribedDate ? new Date(user.newsSubscribedDate).toLocaleString() : 'Not subscribed'}

🌐 WebApp Info:
  Country: ${user.webapp?.country || 'Not available'}
  Platform: ${user.webapp?.platform || 'Not available'}
  Browser: ${user.webapp?.browser || 'Not available'}
  Version: ${user.webapp?.version || 'Not available'}
  OS: ${user.webapp?.os || 'Not available'}

📅 Created: ${user.createdAt ? new Date(user.createdAt).toLocaleString() : 'Not available'}
🔄 Last Updated: ${user.updatedAt ? new Date(user.updatedAt).toLocaleString() : 'Not available'}
`

  await ctx.replyWithHTML(userInfo, { disable_web_page_preview: true })
}

// Register command handlers
composer.command('admin', checkAdminRight, displayAdminPanel)
composer.command('ban', checkAdminRight, async (ctx) => {
  const userId = ctx.message.text.split(' ')[1]
  if (userId) {
    await handleBanUser(ctx, userId)
  } else {
    await ctx.replyWithHTML('Please provide a user ID or username. Usage: /ban <user_id or @username>')
  }
})
composer.hears(/^\/credit\s+(\S+)\s+(-?\d+)$/, checkAdminRight, async (ctx) => {
  const [, userId, amount] = ctx.match
  await handleSetPremium(ctx, `${userId} ${amount}`)
})
composer.hears(/^\/refund\s+(.+)$/, checkAdminRight, async (ctx) => {
  const [, paymentId] = ctx.match
  await handleRefundPayment(ctx, paymentId)
})
composer.command('crypto', checkAdminRight, getLastCryptoTransactions)
composer.command('mono', checkAdminRight, getLastMonoTransactions)
composer.command('stars', checkAdminRight, getStarsTransactions)

// Register menu handlers
composer.hears([I18n.match('start.menu.admin')], checkAdminRight, displayAdminPanel)
composer.action('admin:main', checkAdminRight, displayAdminPanel)
composer.action('admin:user_management', checkAdminRight, displayUserManagement)
composer.action('admin:financial_ops', checkAdminRight, displayFinancialOps)
composer.action('admin:transactions', checkAdminRight, displayTransactionHistory)
composer.action('admin:user:ban', checkAdminRight, toggleUserBan)
composer.action('admin:user:premium', checkAdminRight, setPremiumCredits)
composer.action('admin:user:info', checkAdminRight, viewUserInfo)
composer.action('admin:finance:refund', checkAdminRight, initiateRefund)
composer.action('admin:finance:credits', checkAdminRight, setPremiumCredits)
composer.action('admin:history:crypto', checkAdminRight, getLastCryptoTransactions)
composer.action('admin:history:mono', checkAdminRight, getLastMonoTransactions)
composer.action('admin:history:stars', checkAdminRight, getStarsTransactions)

// Handle "Back" actions
composer.action(/admin:.*:back/, async (ctx) => {
  const [, section] = ctx.match[0].split(':')
  switch (section) {
    case 'user':
    case 'finance':
      return displayAdminPanel(ctx)
    case 'history':
      return displayTransactionHistory(ctx)
    default:
      return displayAdminPanel(ctx)
  }
})

// Load admin type specific handlers
adminType.forEach(type => {
  composer.use(Composer.optional(ctx =>
    ctx.config.mainAdminId === ctx?.from?.id || ctx?.session?.userInfo?.adminRights.includes(type),
    require(`./${type}`)
  ))
})

// Handle unexpected callbacks
composer.action(/admin:.*/, async (ctx) => {
  await ctx.answerCbQuery('This action is not implemented yet.')
  await displayAdminPanel(ctx)
})

// Update the text handler to include user info viewing
composer.on('text', async (ctx, next) => {
  if (!ctx.session.awaitingInput) return next()

  switch (ctx.session.awaitingInput) {
    case 'ban_user':
      await handleBanUser(ctx, ctx.message.text)
      break
    case 'set_premium':
      await handleSetPremium(ctx, ctx.message.text)
      break
    case 'refund_payment':
      await handleRefundPayment(ctx, ctx.message.text)
      break
    case 'view_user_info':
      await handleViewUserInfo(ctx, ctx.message.text)
      break
  }

  ctx.session.awaitingInput = null
})

module.exports = composer
