const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const { escapeHTML: escape } = require('../../utils')

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

// Middleware to check admin rights (any admin role)
const checkAdminRight = (ctx, next) => {
  if (ctx.config.mainAdminId === ctx.from.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.length > 0)) {
    return next()
  }
  return ctx.replyWithHTML('🚫 You are not authorized to access the admin panel.')
}

// Middleware for sensitive operations (main admin only)
const checkMainAdmin = (ctx, next) => {
  if (ctx.config.mainAdminId === ctx.from.id) {
    return next()
  }
  if (ctx.callbackQuery) return ctx.answerCbQuery('🚫 Only the main admin can perform this action.', true)
  return ctx.replyWithHTML('🚫 Only the main admin can perform this action.')
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
      .map(type => [Markup.callbackButton(`⚙️ Admin ${type}`, `admin:${type}`)])
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

🔹 Stars Transactions
🔹 Outgoing Transactions
`

  const inlineKeyboard = [
    [Markup.callbackButton('⭐️ Stars Transactions', 'admin:history:stars')],
    [Markup.callbackButton('📤 Outgoing Transactions', 'admin:history:out')],
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

// Get stars transactions
const getStarsTransactions = async (ctx) => {
  await ctx.answerCbQuery()
  try {
    const transactions = []
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
      'Date,Transaction ID,Amount,USD Amount,User Name,User ID',
      ...transactions.map(item =>
        `"${new Date(item.date * 1000).toLocaleString()}","${item.id}",${item.amount},${(item.amount * 0.013).toFixed(2)},"${item?.source?.user?.first_name?.replace(/"/g, '""') || ''}",${item.source?.user?.id || ''}`
      )
    ].join('\n')

    await ctx.replyWithDocument({ source: Buffer.from(csvContent, 'utf-8'), filename: 'stars_transactions.csv' })

    const last20Transactions = transactions.slice(0, 20)

    const resultText = last20Transactions.map((item, index) =>
      `${index + 1}. <b>${item.amount} stars</b> ($${(item.amount * 0.013).toFixed(2)})\n   🆔 ID: <code>${item.id}</code>\n   👤 From: <a href="tg://user?id=${item.source.user.id}">${escape(item.source.user.first_name)}</a>\n   🕒 ${new Date(item.date * 1000).toLocaleString()}\n`
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

// Get outgoing transactions
const getOutgoingTransactions = async (ctx) => {
  await ctx.answerCbQuery()
  try {
    const transactions = []
    let offset = 0
    const limit = 100

    while (true) {
      const result = await ctx.tg.callApi('getStarTransactions', { limit, offset })
      if (!result.transactions || result.transactions.length === 0) break
      transactions.push(...result.transactions.filter(item => item.receiver))
      if (result.transactions.length < limit) break
      offset += limit
    }

    transactions.sort((a, b) => b.date - a.date)

    const csvContent = [
      'Date,Transaction ID,Amount,USD Amount,Receiver Name,Receiver ID',
      ...transactions.map(item =>
        `"${new Date(item.date * 1000).toLocaleString()}","${item.id}",${item.amount},${(item.amount * 0.013).toFixed(2)},"${item?.receiver?.user?.first_name?.replace(/"/g, '""') || ''}",${item.receiver?.user?.id || ''}`
      )
    ].join('\n')

    await ctx.replyWithDocument({ source: Buffer.from(csvContent, 'utf-8'), filename: 'outgoing_transactions.csv' })

    const last20Transactions = transactions.slice(0, 20)

    const resultText = last20Transactions.map((item, index) =>
      `${index + 1}. <b>${item.amount} stars</b> ($${(item.amount * 0.013).toFixed(2)})\n   🆔 ID: <code>${item.id}</code>\n   👤 To: <a href="tg://user?id=${item.receiver.user.id}">${escape(item.receiver.user.first_name)}</a>\n   🕒 ${new Date(item.date * 1000).toLocaleString()}\n`
    ).join('\n')

    await ctx.editMessageText(`<b>📊 Last 20 Outgoing Transactions</b>\n\n${resultText}\n\nA CSV file with all transactions has been sent.`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([[Markup.callbackButton('🔙 Back', 'admin:transactions')]])
    })
  } catch (error) {
    console.error('Error fetching outgoing transactions:', error)
    await ctx.answerCbQuery('Failed to fetch outgoing transactions. Please try again later.', true)
  }
}

// Handle ban/unban user
const handleBanUser = async (ctx, input) => {
  const user = await findUser(ctx, input)
  if (!user) return ctx.replyWithHTML('❌ User not found. Please check the ID or username and try again.')

  const updatedUser = await ctx.db.User.findByIdAndUpdate(
    user._id,
    { $set: { banned: !user.banned } },
    { new: true }
  )

  await ctx.replyWithHTML(`User ${escape(updatedUser.telegram_id)} (${escape(updatedUser.username)}) banned: ${updatedUser.banned ? 'yes' : 'no'}`)
}

// Handle set premium credits
const handleSetPremium = async (ctx, input) => {
  if (!input || !input.trim()) {
    return ctx.replyWithHTML('❌ Invalid input. Please enter: <code>user_id amount</code>')
  }

  const parts = input.trim().split(/\s+/)
  if (parts.length < 2) {
    return ctx.replyWithHTML('❌ Invalid format. Please enter: <code>user_id amount</code>')
  }

  const [userId, creditStr] = parts
  const credit = parseInt(creditStr)

  if (isNaN(credit)) {
    return ctx.replyWithHTML('❌ Invalid credit amount. Please enter a valid number.')
  }

  const user = await findUser(ctx, userId)
  if (!user) return ctx.replyWithHTML('❌ User not found. Please check the ID or username and try again.')

  const updatedUser = await ctx.db.User.findByIdAndUpdate(
    user._id,
    { $inc: { balance: credit } },
    { new: true }
  )

  await ctx.replyWithHTML(`User ${escape(updatedUser.telegram_id)} (${escape(updatedUser.username)}) balance updated to ${updatedUser.balance} credits (added ${credit} credits)`)

  if (credit !== 0) {
    await ctx.telegram.sendMessage(updatedUser.telegram_id, i18n.t(updatedUser.locale, 'donate.update', {
      amount: credit,
      balance: updatedUser.balance
    }), { parse_mode: 'HTML' })
  }
}

// Handle refund payment
const handleRefundPayment = async (ctx, paymentId) => {
  if (!paymentId || !paymentId.trim()) {
    return ctx.replyWithHTML('❌ Invalid payment ID. Please enter a valid payment ID.')
  }

  const payment = await ctx.db.Payment.findOne({
    'resultData.telegram_payment_charge_id': paymentId.trim()
  })

  if (!payment) return ctx.replyWithHTML('❌ Payment not found.')
  if (payment.status === 'refunded') return ctx.replyWithHTML('❌ Payment already refunded.')

  const refundUser = await ctx.db.User.findOne({ _id: payment.user })
  if (!refundUser) return ctx.replyWithHTML('❌ User not found.')

  try {
    await ctx.telegram.callApi('refundStarPayment', {
      user_id: refundUser.telegram_id,
      telegram_payment_charge_id: paymentId
    })

    // Mark payment as refunded first (idempotency guard prevents double-refund)
    const refunded = await ctx.db.Payment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'refunded' } },
      { $set: { status: 'refunded' } },
      { new: true }
    )

    if (!refunded) {
      return ctx.replyWithHTML('❌ Payment was already refunded by another operation.')
    }

    await ctx.db.User.findByIdAndUpdate(
      refundUser._id,
      { $inc: { balance: -payment.amount } }
    )

    await ctx.replyWithHTML(`✅ Payment ${escape(paymentId)} refunded successfully.`)
  } catch (error) {
    console.error('Refund failed:', error)
    await ctx.replyWithHTML('❌ Refund failed. Please check the logs for more information.')
  }
}

// Helper function to find user by ID or username
const findUser = async (ctx, input) => {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return null
  }
  const cleanInput = input.trim().replace(/^@/, '') // Remove @ prefix if present
  return await ctx.db.User.findOne({
    $or: [{ telegram_id: parseInt(cleanInput) || 0 }, { username: cleanInput }]
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
composer.command('ban', checkMainAdmin, async (ctx) => {
  const userId = ctx.message.text.split(' ')[1]
  if (userId) {
    await handleBanUser(ctx, userId)
  } else {
    await ctx.replyWithHTML('Please provide a user ID or username. Usage: /ban <user_id or @username>')
  }
})
composer.hears(/^\/credit\s+(\S+)\s+(-?\d+)$/, checkMainAdmin, async (ctx) => {
  const [, userId, amount] = ctx.match
  await handleSetPremium(ctx, `${userId} ${amount}`)
})
composer.hears(/^\/refund\s+(.+)$/, checkMainAdmin, async (ctx) => {
  const [, paymentId] = ctx.match
  await handleRefundPayment(ctx, paymentId)
})
composer.command('stars', checkAdminRight, getStarsTransactions)

// Register menu handlers
composer.hears([I18n.match('start.menu.admin')], checkAdminRight, displayAdminPanel)
composer.action('admin:main', checkAdminRight, displayAdminPanel)
composer.action('admin:user_management', checkMainAdmin, displayUserManagement)
composer.action('admin:financial_ops', checkMainAdmin, displayFinancialOps)
composer.action('admin:transactions', checkMainAdmin, displayTransactionHistory)
composer.action('admin:user:ban', checkMainAdmin, toggleUserBan)
composer.action('admin:user:premium', checkMainAdmin, setPremiumCredits)
composer.action('admin:user:info', checkMainAdmin, viewUserInfo)
composer.action('admin:finance:refund', checkMainAdmin, initiateRefund)
composer.action('admin:finance:credits', checkMainAdmin, setPremiumCredits)
composer.action('admin:history:stars', checkMainAdmin, getStarsTransactions)
composer.action('admin:history:out', checkMainAdmin, getOutgoingTransactions)

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

// Handle user input for various operations
const handleAwaitingInput = async (ctx, next) => {
  if (!ctx.session.awaitingInput) return next()

  // Sensitive operations require main admin
  const sensitiveOps = ['ban_user', 'set_premium', 'refund_payment']
  if (sensitiveOps.includes(ctx.session.awaitingInput) && ctx.config.mainAdminId !== ctx.from.id) {
    ctx.session.awaitingInput = null
    return ctx.replyWithHTML('🚫 Only the main admin can perform this action.')
  }

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
}

composer.on('text', handleAwaitingInput)

// Handle unexpected callbacks
composer.action(/admin:.*/, async (ctx) => {
  await ctx.answerCbQuery('This action is not implemented yet.')
  await displayAdminPanel(ctx)
})

module.exports = composer
