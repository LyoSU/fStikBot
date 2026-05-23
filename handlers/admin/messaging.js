// Admin UI for broadcasts. Filename is kept as `messaging.js` because
// `handlers/admin/index.js` resolves it dynamically from the `messaging`
// admin right name; renaming the file would also force migrating that
// right key for every existing admin. Everything inside is new.

const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const moment = require('moment')

const escapeHTML = require('../../utils/html-escape')
const { tolerantEditMessage } = require('../../utils/safe-edit')
const broadcast = require('../../broadcast')
const { STATUS } = broadcast

const composer = new Composer()

const STATUS_BADGES = {
  [STATUS.DRAFT]: '📝 Draft',
  [STATUS.QUEUED]: '⏳ Queued',
  [STATUS.SENDING]: '🚀 Sending',
  [STATUS.PAUSED]: '⏸ Paused',
  [STATUS.COMPLETED]: '✅ Completed',
  [STATUS.CANCELLED]: '❌ Cancelled',
  [STATUS.FAILED]: '💥 Failed'
}

const renderProgressBar = (sent, total, width = 12) => {
  if (!total) return '░'.repeat(width)
  const filled = Math.round((sent / total) * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const renderStatusText = (b) => {
  const total = b.progress.total || 0
  const sent = b.progress.sent || 0
  const failed = b.progress.failed || 0
  const completionPct = total ? Math.round((sent / total) * 100) : 0

  const lines = [
    '<b>📊 Broadcast status</b>',
    '',
    `<b>Name:</b> ${escapeHTML(b.name)}`,
    `<b>Status:</b> ${STATUS_BADGES[b.status] || b.status}`,
    `<b>Audience:</b> ${escapeHTML(b.audience.type)}`,
    `<b>Scheduled:</b> <code>${moment(b.scheduledAt).format('DD MMM YYYY HH:mm')}</code>`,
    `<b>Created:</b> <code>${moment(b.createdAt).format('DD MMM YYYY HH:mm')}</code>`,
    '',
    `<b>Progress:</b> ${completionPct}% ${renderProgressBar(sent, total)}`,
    `<b>Sent:</b> ${sent.toLocaleString()} / ${total.toLocaleString()}`,
    `<b>Failed:</b> ${failed.toLocaleString()}`
  ]

  if (b.errorCounts && typeof b.errorCounts === 'object') {
    const entries = Object.entries(b.errorCounts)
    if (entries.length) {
      lines.push('', '<b>Errors by category:</b>')
      for (const [code, count] of entries) {
        lines.push(`  • ${code}: ${count}`)
      }
    }
  }

  if (b.pausedReason) {
    lines.push('', `<b>⚠️ Pause reason:</b> ${escapeHTML(b.pausedReason)}`)
  }

  if (b.errorSamples && b.errorSamples.length) {
    lines.push('', '<b>Recent error samples:</b>')
    for (const s of b.errorSamples.slice(-5)) {
      lines.push(`  • <code>${s.telegram_id}</code> [${s.code}]: ${escapeHTML(s.message || '')}`)
    }
  }

  return lines.join('\n')
}

const statusKeyboard = (b) => {
  const rows = [
    [
      Markup.callbackButton('🔄 Refresh', `admin:messaging:status:${b._id}`),
      Markup.callbackButton('👁 View post', `admin:messaging:view:${b._id}`)
    ]
  ]
  if (!broadcast.isTerminal(b.status)) {
    rows.push([Markup.callbackButton('❌ Cancel broadcast', `admin:messaging:cancel:${b._id}`)])
  }
  if (b.status === STATUS.PAUSED) {
    rows.push([Markup.callbackButton('▶️ Resume', `admin:messaging:resume:${b._id}`)])
  }
  rows.push([
    Markup.callbackButton('← Broadcasts', 'admin:messaging'),
    Markup.callbackButton('⚙️ Admin', 'admin:back')
  ])
  return Markup.inlineKeyboard(rows)
}

// ───────────────────────────────────────────────────────────────────────
// Main menu
// ───────────────────────────────────────────────────────────────────────
composer.action(/^admin:messaging$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  await tolerantEditMessage(ctx, '📣 <b>Broadcasts</b>\n\nPick an action:', {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.callbackButton('➕ New broadcast', 'admin:messaging:create')],
      [Markup.callbackButton('📋 Active', 'admin:messaging:list:active:1')],
      [Markup.callbackButton('📁 Archive', 'admin:messaging:list:archive:1')],
      [Markup.callbackButton('« Admin', 'admin:back')]
    ])
  })
})

composer.action('admin:messaging:create', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  return ctx.scene.enter('broadcastNewName')
})

// ───────────────────────────────────────────────────────────────────────
// List (active vs archive)
// ───────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 10

composer.action(/^admin:messaging:list:(active|archive):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const kind = ctx.match[1]
  const page = Math.max(1, parseInt(ctx.match[2], 10) || 1)

  const filter = kind === 'archive'
    ? { status: { $in: [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED] } }
    : { status: { $nin: [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED] } }

  const total = await ctx.db.Broadcast.countDocuments(filter)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, pages)

  const items = await ctx.db.Broadcast
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select('name status progress.total progress.sent createdAt')
    .lean()

  const rows = items.map((b) => {
    const label = `${STATUS_BADGES[b.status] || b.status} ${b.name}`.slice(0, 60)
    return [Markup.callbackButton(label, `admin:messaging:status:${b._id}`)]
  })

  const nav = []
  if (safePage > 1) nav.push(Markup.callbackButton(`‹ ${safePage - 1}`, `admin:messaging:list:${kind}:${safePage - 1}`))
  if (safePage < pages) nav.push(Markup.callbackButton(`${safePage + 1} ›`, `admin:messaging:list:${kind}:${safePage + 1}`))
  if (nav.length) rows.push(nav)

  rows.push([
    Markup.callbackButton('← Broadcasts', 'admin:messaging'),
    Markup.callbackButton('⚙️ Admin', 'admin:back')
  ])

  const headline = kind === 'archive' ? '📁 <b>Archive</b>' : '📋 <b>Active broadcasts</b>'
  const body = total === 0
    ? `${headline}\n\n<i>Nothing here.</i>`
    : `${headline}\n\nPage ${safePage}/${pages} · ${total} total`

  await tolerantEditMessage(ctx, body, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard(rows)
  })
})

// ───────────────────────────────────────────────────────────────────────
// Status / Refresh
// ───────────────────────────────────────────────────────────────────────
composer.action(/^admin:messaging:status:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const b = await ctx.db.Broadcast.findById(ctx.match[1]).lean()
  if (!b) {
    return tolerantEditMessage(ctx, '⚠️ Broadcast not found.', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[
        Markup.callbackButton('← Broadcasts', 'admin:messaging')
      ]])
    })
  }

  await tolerantEditMessage(ctx, renderStatusText(b), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: statusKeyboard(b)
  })
})

// ───────────────────────────────────────────────────────────────────────
// View captured post (re-send to operator for verification)
// ───────────────────────────────────────────────────────────────────────
composer.action(/^admin:messaging:view:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const b = await ctx.db.Broadcast.findById(ctx.match[1]).lean()
  if (!b) return ctx.replyWithHTML('⚠️ Broadcast not found.')

  await broadcast.renderPreview(ctx.telegram, ctx.chat.id, b.message).catch((err) => {
    ctx.replyWithHTML(`❌ Preview failed: <code>${escapeHTML(err.message || err.description || 'unknown')}</code>`)
  })
})

// ───────────────────────────────────────────────────────────────────────
// Cancel
// ───────────────────────────────────────────────────────────────────────
composer.action(/^admin:messaging:cancel:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const id = ctx.match[1]

  // Only flip status if it's currently non-terminal. The runner's per-batch
  // status poll will notice on its next checkpoint and exit cleanly.
  const updated = await ctx.db.Broadcast.findOneAndUpdate(
    { _id: id, status: { $nin: [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED] } },
    { $set: { status: STATUS.CANCELLED, completedAt: new Date() } },
    { new: true }
  )

  if (!updated) {
    return ctx.replyWithHTML('⚠️ Cannot cancel — broadcast already finished.')
  }

  // Drop materialized recipients so we don't carry the queue around forever.
  broadcast.cleanupRecipients(id).catch(() => {})

  await tolerantEditMessage(ctx, renderStatusText(updated), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: statusKeyboard(updated)
  })
})

// ───────────────────────────────────────────────────────────────────────
// Resume (from paused → queued, runner picks up on next tick)
// ───────────────────────────────────────────────────────────────────────
composer.action(/^admin:messaging:resume:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const updated = await ctx.db.Broadcast.findOneAndUpdate(
    { _id: ctx.match[1], status: STATUS.PAUSED },
    { $set: { status: STATUS.QUEUED, pausedReason: null } },
    { new: true }
  )
  if (!updated) {
    return ctx.replyWithHTML('⚠️ Cannot resume — broadcast is not paused.')
  }
  await tolerantEditMessage(ctx, renderStatusText(updated), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: statusKeyboard(updated)
  })
})

module.exports = composer
