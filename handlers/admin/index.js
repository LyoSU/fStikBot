const path = require('path')
const metrics = require('../../utils/metrics')
const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const { escapeHTML: escape } = require('../../utils')
const {
  ADMIN_RIGHTS,
  isMainAdmin,
  isAnyAdmin,
  hasRight,
  getAdminRights,
  requireAnyAdmin,
  requireRight,
  sendDeny
} = require('./_helpers')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../../locales'),
  defaultLanguage: 'en',
  sessionName: 'session',
  useSession: true,
  allowMissing: false,
  skipPluralize: true
})

const composer = new Composer()

// --- Awaiting-input state machine -------------------------------------------
// One key per operation. Each entry declares the right it needs and the
// handler invoked once the admin replies. This kills the previous
// switch-case + hardcoded sensitiveOps list in two places.

const AWAITING = {
  ban_user: { right: 'users', handler: (ctx, input) => handleBanUser(ctx, input) },
  set_premium: { right: 'finance', handler: (ctx, input) => handleSetPremium(ctx, input) },
  refund_payment: { right: 'finance', handler: (ctx, input) => handleRefundPayment(ctx, input) },
  view_user_info: { right: 'users', handler: (ctx, input) => handleViewUserInfo(ctx, input) }
}

const cancelInputKeyboard = Markup.inlineKeyboard([
  [Markup.callbackButton('✖️ Cancel', 'admin:input:cancel')]
])

const promptInput = async (ctx, key, text) => {
  await ctx.answerCbQuery().catch(() => {})
  ctx.session.awaitingInput = key
  await ctx.replyWithHTML(text, { reply_markup: cancelInputKeyboard })
}

// --- Pagination helper for getStarTransactions ------------------------------
// Caps total transactions to avoid unbounded admin flow on high-traffic bots.
// filterKey: 'source' (incoming) or 'receiver' (outgoing).
const fetchTransactions = async (tg, filterKey, maxTransactions = 10000) => {
  const transactions = []
  const limit = 100
  let offset = 0
  let truncated = false

  while (true) {
    const result = await tg.callApi('getStarTransactions', { limit, offset })
    if (!result.transactions || result.transactions.length === 0) break
    transactions.push(...result.transactions.filter(item => item[filterKey]))
    if (result.transactions.length < limit) break
    offset += limit
    if (transactions.length >= maxTransactions) {
      truncated = true
      break
    }
  }

  if (transactions.length > maxTransactions) transactions.length = maxTransactions
  return { transactions, truncated }
}

// --- Menus ------------------------------------------------------------------
// Each menu builds inline keyboard reactively from the current admin's
// rights, so a sub-admin only ever sees buttons they can actually use.

const sectionLabel = (right) => {
  switch (right) {
    case 'messaging': return '📣 Broadcasts'
    case 'pack': return '📦 Pack management'
    case 'finance': return '💰 Financial ops'
    case 'users': return '👥 User management'
    default: return `⚙️ ${right}`
  }
}

const sectionCallback = (right) => {
  switch (right) {
    case 'messaging': return 'admin:messaging'
    case 'pack': return 'admin:pack'
    case 'finance': return 'admin:financial_ops'
    case 'users': return 'admin:user_management'
    default: return `admin:${right}`
  }
}

const renderMessage = async (ctx, text, replyMarkup) => {
  const opts = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  }
  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, opts).catch(() => ctx.replyWithHTML(text, opts))
  }
  return ctx.replyWithHTML(text, opts)
}

const displayAdminPanel = async (ctx) => {
  const rights = isMainAdmin(ctx) ? ADMIN_RIGHTS : getAdminRights(ctx)
  const visibleRights = ADMIN_RIGHTS.filter(r => rights.includes(r))

  const showTransactions = isMainAdmin(ctx) || rights.includes('finance')

  const text = [
    '🔐 <b>Admin Panel</b>',
    '',
    isMainAdmin(ctx) ? '👑 You are the main admin.' : `🛡 Your rights: <b>${rights.join(', ') || 'none'}</b>`
  ].join('\n')

  const buttons = visibleRights.map(r => [Markup.callbackButton(sectionLabel(r), sectionCallback(r))])
  if (showTransactions) {
    buttons.push([Markup.callbackButton('📊 Transaction history', 'admin:transactions')])
  }
  buttons.push([Markup.callbackButton('📈 Product metrics', 'admin:metrics')])

  await renderMessage(ctx, text, Markup.inlineKeyboard(buttons))
}

// Conversion rates: [label, from events, to events] — each side is a sum.
// Sticker and video rates count finished attempts only: duplicates are not
// failures, and a queued video has no outcome until the worker reports it.
const METRIC_FUNNELS = [
  ['/new → pack created', ['new_pack_started'], ['pack_created']],
  ['copy → pack created', ['copy_started'], ['copy_created']],
  ['stickers added (non-video)', ['sticker_added', 'sticker_failed'], ['sticker_added']],
  ['videos added', ['video_added', 'video_failed'], ['video_added']],
  ['files → added, all', ['sticker_received'], ['sticker_added', 'video_added']]
]

const displayMetrics = async (ctx) => {
  const days = await metrics.recent(7)
  const total = {}
  for (const { counts } of days) {
    for (const [name, count] of Object.entries(counts)) total[name] = (total[name] || 0) + count
  }
  const today = days[0]?.day === new Date().toISOString().slice(0, 10) ? days[0].counts : {}

  const sum = (names) => names.reduce((acc, name) => acc + (total[name] || 0), 0)
  const funnels = METRIC_FUNNELS
    .map(([label, from, to]) => [label, sum(from), sum(to)])
    .filter(([, from]) => from)
    .map(([label, from, to]) => `${label}: <b>${Math.round((to / from) * 100)}%</b> (${to}/${from})`)

  const rows = Object.keys(total).sort().map((name) => `<code>${name}</code> — ${total[name]} <i>(today ${today[name] || 0})</i>`)

  const text = [
    '📈 <b>Product metrics</b> — last 7 days',
    '',
    ...(funnels.length ? [...funnels, ''] : []),
    ...(rows.length ? rows : ['<i>No data yet.</i>'])
  ].join('\n')

  await renderMessage(ctx, text, Markup.inlineKeyboard([
    [Markup.callbackButton('🔄 Refresh', 'admin:metrics')],
    [Markup.callbackButton('« Back', 'admin:back')]
  ]))
}

const displayUserManagement = async (ctx) => {
  const text = '👥 <b>User management</b>\n\nPick an action:'
  const buttons = Markup.inlineKeyboard([
    [Markup.callbackButton('🚫 Ban / Unban user', 'admin:user:ban')],
    [Markup.callbackButton('ℹ️ View user info', 'admin:user:info')],
    [Markup.callbackButton('« Admin panel', 'admin:back')]
  ])
  await renderMessage(ctx, text, buttons)
}

const displayFinancialOps = async (ctx) => {
  const text = '💰 <b>Financial operations</b>\n\nPick an action:'
  const buttons = Markup.inlineKeyboard([
    [Markup.callbackButton('💸 Refund payment', 'admin:finance:refund')],
    [Markup.callbackButton('💳 Add / Remove credits', 'admin:finance:credits')],
    [Markup.callbackButton('📜 Payment history', 'admin:finance:history')],
    [Markup.callbackButton('« Admin panel', 'admin:back')]
  ])
  await renderMessage(ctx, text, buttons)
}

const displayTransactionHistory = async (ctx) => {
  const text = '📊 <b>Transaction history</b>\n\nPick a report:'
  const buttons = Markup.inlineKeyboard([
    [Markup.callbackButton('⭐️ Incoming (stars)', 'admin:history:stars')],
    [Markup.callbackButton('📤 Outgoing', 'admin:history:out')],
    [Markup.callbackButton('« Admin panel', 'admin:back')]
  ])
  await renderMessage(ctx, text, buttons)
}

// --- Awaiting-input prompts -------------------------------------------------

const promptBanUser = (ctx) => promptInput(ctx, 'ban_user',
  '🚫 Send the user ID or @username to ban / unban.')

const promptSetPremium = (ctx) => promptInput(ctx, 'set_premium',
  '⭐️ Send <code>user_id amount</code> (negative to remove). E.g. <code>123456 100</code> or <code>@username -50</code>.')

const promptRefund = (ctx) => promptInput(ctx, 'refund_payment',
  '💸 Send the Telegram payment charge ID to refund.')

const promptViewUserInfo = (ctx) => promptInput(ctx, 'view_user_info',
  'ℹ️ Send the user ID or @username to view info.')

// --- Reports ----------------------------------------------------------------

const renderTransactionsReport = async (ctx, { kind, transactions, truncated }) => {
  const direction = kind === 'source' ? 'Stars' : 'Outgoing'
  const csvFilename = kind === 'source' ? 'stars_transactions.csv' : 'outgoing_transactions.csv'
  const userKey = kind === 'source' ? 'source' : 'receiver'
  const partyLabel = kind === 'source' ? 'From' : 'To'

  const csvHeader = (truncated ? `# truncated to first ${transactions.length} transactions\n` : '') +
    `Date,Transaction ID,Amount,USD,${partyLabel} Name,${partyLabel} ID`

  const csvBody = transactions.map((item) => {
    const u = item[userKey]?.user
    const name = (u?.first_name || '').replace(/"/g, '""')
    return `"${new Date(item.date * 1000).toLocaleString()}","${item.id}",${item.amount},${(item.amount * 0.013).toFixed(2)},"${name}",${u?.id || ''}`
  })

  await ctx.replyWithDocument({
    source: Buffer.from([csvHeader, ...csvBody].join('\n'), 'utf-8'),
    filename: csvFilename
  })

  const last20 = transactions.slice(0, 20)
  const list = last20.map((item, i) => {
    const u = item[userKey]?.user
    const userLink = u
      ? `<a href="tg://user?id=${u.id}">${escape(u.first_name || '')}</a>`
      : '<i>unknown</i>'
    return `${i + 1}. <b>${item.amount} ⭐️</b> ($${(item.amount * 0.013).toFixed(2)})\n` +
           `   🆔 <code>${item.id}</code>\n` +
           `   👤 ${partyLabel}: ${userLink}\n` +
           `   🕒 ${new Date(item.date * 1000).toLocaleString()}`
  }).join('\n\n')

  const truncatedNote = truncated
    ? `\n\n⚠️ <i>List truncated to first ${transactions.length} transactions.</i>`
    : ''

  await renderMessage(
    ctx,
    `<b>📊 Last 20 ${direction} transactions</b>\n\n${list || '<i>No transactions.</i>'}\n\nFull CSV attached.${truncatedNote}`,
    Markup.inlineKeyboard([[Markup.callbackButton('« Transaction history', 'admin:transactions')]])
  )
}

const getStarsTransactions = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  try {
    const { transactions, truncated } = await fetchTransactions(ctx.tg, 'source')
    transactions.sort((a, b) => b.date - a.date)
    await renderTransactionsReport(ctx, { kind: 'source', transactions, truncated })
  } catch (error) {
    console.error('Error fetching stars transactions:', error)
    await ctx.replyWithHTML('❌ Failed to fetch stars transactions. Try again later.')
  }
}

const getOutgoingTransactions = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  try {
    const { transactions, truncated } = await fetchTransactions(ctx.tg, 'receiver')
    transactions.sort((a, b) => b.date - a.date)
    await renderTransactionsReport(ctx, { kind: 'receiver', transactions, truncated })
  } catch (error) {
    console.error('Error fetching outgoing transactions:', error)
    await ctx.replyWithHTML('❌ Failed to fetch outgoing transactions. Try again later.')
  }
}

// --- User lookup ------------------------------------------------------------

const findUser = async (ctx, input) => {
  if (!input || typeof input !== 'string' || !input.trim()) return null
  const cleanInput = input.trim().replace(/^@/, '')
  const numeric = Number(cleanInput)
  const isNumeric = !Number.isNaN(numeric) && Number.isInteger(numeric) && cleanInput !== ''

  // Numeric input → username could legitimately be all digits, so query both.
  // Non-numeric → username only (avoids accidental telegram_id:0 match).
  const orClauses = isNumeric
    ? [{ telegram_id: parseInt(cleanInput, 10) }, { username: cleanInput }]
    : [{ username: cleanInput }]

  return ctx.db.User.findOne({ $or: orClauses })
}

// --- Mutations --------------------------------------------------------------

const handleBanUser = async (ctx, input) => {
  const user = await findUser(ctx, input)
  if (!user) return ctx.replyWithHTML('❌ User not found. Check the ID or username and try again.')

  const updated = await ctx.db.User.findByIdAndUpdate(
    user._id,
    { $set: { banned: !user.banned } },
    { new: true }
  )

  const status = updated.banned ? '🚫 banned' : '✅ unbanned'
  await ctx.replyWithHTML(
    `User <code>${escape(updated.telegram_id)}</code> ` +
    `${updated.username ? `(@${escape(updated.username)})` : ''} is now ${status}.`
  )
}

const handleSetPremium = async (ctx, input) => {
  if (!input || !input.trim()) {
    return ctx.replyWithHTML('❌ Empty input. Format: <code>user_id amount</code>')
  }

  const parts = input.trim().split(/\s+/)
  if (parts.length < 2) {
    return ctx.replyWithHTML('❌ Invalid format. Use: <code>user_id amount</code>')
  }

  const [userId, creditStr] = parts
  const credit = parseInt(creditStr, 10)
  if (Number.isNaN(credit)) {
    return ctx.replyWithHTML('❌ Invalid credit amount. Send an integer (negative to subtract).')
  }

  const user = await findUser(ctx, userId)
  if (!user) return ctx.replyWithHTML('❌ User not found. Check the ID or username and try again.')

  const updated = await ctx.db.User.findByIdAndUpdate(
    user._id,
    { $inc: { balance: credit } },
    { new: true }
  )

  const sign = credit >= 0 ? '+' : ''
  await ctx.replyWithHTML(
    `✅ User <code>${escape(updated.telegram_id)}</code> ` +
    `${updated.username ? `(@${escape(updated.username)}) ` : ''}` +
    `balance: <b>${updated.balance}</b> credits (${sign}${credit}).`
  )

  if (credit !== 0) {
    await ctx.telegram.sendMessage(
      updated.telegram_id,
      i18n.t(updated.locale, 'donate.update', { amount: credit, balance: updated.balance }),
      { parse_mode: 'HTML' }
    ).catch((err) => console.error('Failed to notify user about credit change:', err.message))
  }
}

const handleRefundPayment = async (ctx, paymentId) => {
  if (!paymentId || !paymentId.trim()) {
    return ctx.replyWithHTML('❌ Empty payment ID.')
  }

  const trimmed = paymentId.trim()
  const payment = await ctx.db.Payment.findOne({
    'resultData.telegram_payment_charge_id': trimmed
  })

  if (!payment) return ctx.replyWithHTML('❌ Payment not found.')
  if (payment.status === 'refunded') return ctx.replyWithHTML('❌ Payment already refunded.')

  const refundUser = await ctx.db.User.findOne({ _id: payment.user })
  if (!refundUser) return ctx.replyWithHTML('❌ User attached to that payment was not found.')

  try {
    await ctx.telegram.callApi('refundStarPayment', {
      user_id: refundUser.telegram_id,
      telegram_payment_charge_id: trimmed
    })

    // Idempotency guard: only one concurrent refund flips status.
    const refunded = await ctx.db.Payment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'refunded' } },
      { $set: { status: 'refunded' } },
      { new: true }
    )
    if (!refunded) {
      return ctx.replyWithHTML('❌ Payment was already refunded by another operation.')
    }

    await ctx.db.User.findByIdAndUpdate(refundUser._id, { $inc: { balance: -payment.amount } })

    await ctx.replyWithHTML(`✅ Payment <code>${escape(trimmed)}</code> refunded successfully.`)
  } catch (error) {
    console.error('Refund failed:', error)
    await ctx.replyWithHTML(`❌ Refund failed: <code>${escape(error.description || error.message || 'unknown error')}</code>`)
  }
}

const handleViewUserInfo = async (ctx, input) => {
  const user = await findUser(ctx, input)
  if (!user) return ctx.replyWithHTML('❌ User not found. Check the ID or username and try again.')

  const lines = [
    '👤 <b>User information</b>',
    '',
    `🆔 <code>${escape(user.telegram_id)}</code>`,
    `👤 ${escape(user.first_name || '')}${user.last_name ? ' ' + escape(user.last_name) : ''}`,
    `🏷 ${user.username ? '@' + escape(user.username) : '<i>no username</i>'}`,
    `💰 Balance: <b>${user.balance}</b>`,
    `🌍 Locale: ${user.locale || '<i>unset</i>'}`,
    `🚫 Banned: ${user.banned ? 'yes' : 'no'}`,
    `🔒 Blocked: ${user.blocked ? 'yes' : 'no'}`,
    `👑 Admin rights: ${(user.adminRights && user.adminRights.length) ? user.adminRights.join(', ') : 'none'}`,
    `🛡 Moderator: ${user.moderator ? 'yes' : 'no'}`,
    `🚷 Public ban: ${user.publicBan ? 'yes' : 'no'}`,
    '',
    `📦 Sticker set: ${user.stickerSet ? `<code>${escape(user.stickerSet)}</code>` : '<i>unset</i>'}`,
    `🔠 Inline sticker set: ${user.inlineStickerSet ? `<code>${escape(user.inlineStickerSet)}</code>` : '<i>unset</i>'}`,
    `📊 Inline type: ${user.inlineType || '<i>unset</i>'}`
  ]

  if (user.webapp && (user.webapp.country || user.webapp.platform)) {
    lines.push('', '🌐 <b>WebApp:</b>')
    if (user.webapp.country) lines.push(`  Country: ${escape(user.webapp.country)}`)
    if (user.webapp.platform) lines.push(`  Platform: ${escape(user.webapp.platform)}`)
    if (user.webapp.os) lines.push(`  OS: ${escape(user.webapp.os)}`)
    if (user.webapp.browser) lines.push(`  Browser: ${escape(user.webapp.browser)} ${escape(user.webapp.version || '')}`)
  }

  lines.push('')
  if (user.createdAt) lines.push(`📅 Joined: ${new Date(user.createdAt).toLocaleString()}`)
  if (user.updatedAt) lines.push(`🔄 Updated: ${new Date(user.updatedAt).toLocaleString()}`)

  await ctx.replyWithHTML(lines.join('\n'), { disable_web_page_preview: true })
}

// --- Awaiting-input dispatcher ---------------------------------------------

const handleAwaitingInput = async (ctx, next) => {
  const key = ctx.session.awaitingInput
  if (!key) return next()

  const text = ctx.message?.text || ''

  // Slash commands always escape the awaiting state — otherwise typing
  // /admin while in "send me a user_id" would feed the command to the
  // input handler and be silently discarded.
  if (text.startsWith('/')) {
    ctx.session.awaitingInput = null
    return next()
  }

  const op = AWAITING[key]
  if (!op) {
    ctx.session.awaitingInput = null
    return next()
  }

  // Re-check the right at apply-time: a sub-admin could have lost the right
  // (or had it revoked) between prompt and reply.
  if (!hasRight(ctx, op.right)) {
    ctx.session.awaitingInput = null
    return sendDeny(ctx, `⛔ This action requires the <b>${op.right}</b> admin right.`)
  }

  ctx.session.awaitingInput = null
  try {
    await op.handler(ctx, text)
  } catch (err) {
    console.error(`Admin awaiting-input handler "${key}" failed:`, err)
    await ctx.replyWithHTML('❌ Something went wrong. Check the logs.').catch(() => {})
  }
}

// --- Wiring -----------------------------------------------------------------

// Entry points
composer.command('admin', requireAnyAdmin, displayAdminPanel)
composer.hears([I18n.match('start.menu.admin')], requireAnyAdmin, displayAdminPanel)
// Returning to the panel must also escape any active scene — otherwise
// the user is silently re-entered into the broadcast wizard on their
// next message.
const backToPanel = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  if (ctx.scene && ctx.scene.current) await ctx.scene.leave().catch(() => {})
  ctx.session.scene = null
  return displayAdminPanel(ctx)
}
composer.action('admin:main', requireAnyAdmin, backToPanel)
composer.action('admin:back', requireAnyAdmin, backToPanel)
composer.action('admin:menu', requireAnyAdmin, backToPanel)

// Cancel an awaiting-input prompt.
composer.action('admin:input:cancel', async (ctx) => {
  ctx.session.awaitingInput = null
  await ctx.answerCbQuery('Cancelled').catch(() => {})
  await ctx.editMessageText('✖️ Cancelled.', { parse_mode: 'HTML' }).catch(() => {})
})
composer.command('admincancel', (ctx) => {
  if (!ctx.session.awaitingInput) {
    return ctx.replyWithHTML('Nothing to cancel.')
  }
  ctx.session.awaitingInput = null
  return ctx.replyWithHTML('✖️ Cancelled.')
})

// Direct commands
composer.command('ban', requireRight('users'), async (ctx) => {
  const userId = ctx.message.text.split(' ').slice(1).join(' ').trim()
  if (!userId) {
    return ctx.replyWithHTML('Usage: <code>/ban &lt;user_id or @username&gt;</code>')
  }
  await handleBanUser(ctx, userId)
})
composer.hears(/^\/credit\s+(\S+)\s+(-?\d+)$/, requireRight('finance'), async (ctx) => {
  const [, userId, amount] = ctx.match
  await handleSetPremium(ctx, `${userId} ${amount}`)
})
composer.hears(/^\/refund\s+(.+)$/, requireRight('finance'), async (ctx) => {
  const [, paymentId] = ctx.match
  await handleRefundPayment(ctx, paymentId)
})
composer.command('stars', requireRight('finance'), getStarsTransactions)

// Submenus
composer.action('admin:user_management', requireRight('users'), displayUserManagement)
composer.action('admin:financial_ops', requireRight('finance'), displayFinancialOps)
composer.action('admin:transactions', requireRight('finance'), displayTransactionHistory)
composer.action('admin:metrics', requireAnyAdmin, displayMetrics)

// User-management actions
composer.action('admin:user:ban', requireRight('users'), promptBanUser)
composer.action('admin:user:info', requireRight('users'), promptViewUserInfo)

// Finance actions
composer.action('admin:finance:refund', requireRight('finance'), promptRefund)
composer.action('admin:finance:credits', requireRight('finance'), promptSetPremium)
composer.action('admin:finance:history', requireRight('finance'), getStarsTransactions)

// Transaction reports
composer.action('admin:history:stars', requireRight('finance'), getStarsTransactions)
composer.action('admin:history:out', requireRight('finance'), getOutgoingTransactions)

// Sub-section composers (messaging / pack). Composer.optional silently drops
// the update when the predicate is false, so sub-admins without the right
// fall through to the catch-all below for proper feedback.
const sectionRights = ['messaging', 'pack']
sectionRights.forEach((right) => {
  composer.use(Composer.optional((ctx) => hasRight(ctx, right), require(`./${right}`)))
})

// Awaiting-input dispatcher — must come AFTER section composers so that
// scenes that read text don't get short-circuited.
composer.on('text', handleAwaitingInput)

// Catch-all for unrecognised admin:* callbacks. Silent for outsiders;
// gentle reroute to the panel for actual admins (no scary "not implemented"
// toast — the user just lands back at the menu).
composer.action(/^admin:/, async (ctx) => {
  if (!isAnyAdmin(ctx)) return
  await ctx.answerCbQuery().catch(() => {})
  return displayAdminPanel(ctx)
})

module.exports = composer
