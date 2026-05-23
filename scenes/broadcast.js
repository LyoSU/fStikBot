// Broadcast creation flow — plain `telegraf/scenes/base` instances, matching
// the rest of the project's scene style (pack-new, packRename, donate, …).
// Draft state lives on `ctx.session.scene` and is reset on first scene entry.

const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

const broadcast = require('../broadcast')
const escapeHTML = require('../utils/html-escape')
const log = require('../utils/logger').scope('broadcast:wizard')

const NAME_MAX_LEN = 200

// ───────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────
const cancelKeyboard = Markup.inlineKeyboard([
  [Markup.callbackButton('✖️ Cancel', 'broadcast:new:cancel')]
])

const audienceKeyboard = () => Markup.inlineKeyboard([
  ...broadcast.audiences.list().map(({ key, label }) => (
    [Markup.callbackButton(label, `broadcast:new:audience:${key}`)]
  )),
  [Markup.callbackButton('✖️ Cancel', 'broadcast:new:cancel')]
])

const confirmKeyboard = Markup.inlineKeyboard([
  [
    Markup.callbackButton('🚀 Publish', 'broadcast:new:publish'),
    Markup.callbackButton('✖️ Cancel', 'broadcast:new:cancel')
  ]
])

// Anything `replicators.copyMethods` can replicate counts as a valid post.
const detectMessageType = (message) => {
  if (!message) return null
  return Object.keys(replicators.copyMethods).find((type) => message[type] !== undefined) || null
}

// Telegram message envelope keys that are NEVER the "content" type. Listing
// them lets us log the actually-interesting top-level keys when we can't
// detect a supported payload type.
const MESSAGE_META_KEYS = new Set([
  'message_id', 'from', 'sender_chat', 'date', 'chat', 'forward_from',
  'forward_from_chat', 'forward_from_message_id', 'forward_signature',
  'forward_sender_name', 'forward_date', 'is_automatic_forward',
  'reply_to_message', 'via_bot', 'edit_date', 'has_protected_content',
  'media_group_id', 'author_signature', 'entities', 'caption_entities',
  'caption', 'reply_markup', 'has_media_spoiler', 'is_topic_message',
  'message_thread_id', 'link_preview_options', 'effect_id', 'show_caption_above_media'
])

// Capture the operator's post into a portable payload (see broadcast/send.js
// for how it's later replayed verbatim).
const captureMessage = (message) => {
  const type = detectMessageType(message)
  if (!type) {
    // Log the unfamiliar top-level keys so we know when a new Bot API type
    // (paid_media, story, gift, …) appears in the wild and we should extend
    // telegraf or write a custom replicator.
    const novelKeys = Object.keys(message || {}).filter((k) => !MESSAGE_META_KEYS.has(k))
    log.warn('unsupported message type — unknown content keys:', novelKeys.join(', ') || '(none)')
    return null
  }
  return {
    type,
    data: replicators[type](message),
    replyMarkup: message.reply_markup || null
  }
}

const exitScene = async (ctx, message) => {
  ctx.session.scene = {}
  if (message) await ctx.replyWithHTML(message).catch(() => {})
  return ctx.scene.leave()
}

// ───────────────────────────────────────────────────────────────────────
// Scene: name
// ───────────────────────────────────────────────────────────────────────
const broadcastNewName = new Scene('broadcastNewName')

broadcastNewName.enter(async (ctx) => {
  ctx.session.scene = {}
  await ctx.replyWithHTML(
    '📣 <b>New broadcast</b>\n\n' +
    `Enter an internal name for this campaign (≤${NAME_MAX_LEN} chars; users won't see it).`,
    { reply_markup: cancelKeyboard }
  )
})

broadcastNewName.on('text', async (ctx) => {
  const name = (ctx.message.text || '').trim()
  if (!name) {
    return ctx.replyWithHTML('Please send a text name.', { reply_markup: cancelKeyboard })
  }
  ctx.session.scene.name = name.slice(0, NAME_MAX_LEN)
  return ctx.scene.enter('broadcastNewMessage')
})

broadcastNewName.action('broadcast:new:cancel', (ctx) => exitScene(ctx, '✖️ Cancelled.'))

// ───────────────────────────────────────────────────────────────────────
// Scene: message
// ───────────────────────────────────────────────────────────────────────
const broadcastNewMessage = new Scene('broadcastNewMessage')

broadcastNewMessage.enter(async (ctx) => {
  await ctx.replyWithHTML(
    '✅ Name saved.\n\n' +
    'Now send the post to broadcast — exactly as you want users to receive it.\n' +
    '<i>Any message type. Inline buttons (URL, copy-text, web app, colored — all of them) are preserved.</i>',
    { reply_markup: cancelKeyboard }
  )
})

broadcastNewMessage.on('message', async (ctx) => {
  const captured = captureMessage(ctx.message)
  if (!captured) {
    return ctx.replyWithHTML(
      '❌ Unsupported message type — send a regular text/photo/video/document/etc.',
      { reply_markup: cancelKeyboard }
    )
  }
  ctx.session.scene.message = captured
  return ctx.scene.enter('broadcastNewDate')
})

broadcastNewMessage.action('broadcast:new:cancel', (ctx) => exitScene(ctx, '✖️ Cancelled.'))

// ───────────────────────────────────────────────────────────────────────
// Scene: date
// ───────────────────────────────────────────────────────────────────────
const broadcastNewDate = new Scene('broadcastNewDate')

broadcastNewDate.enter(async (ctx) => {
  await ctx.replyWithHTML(
    '✅ Post captured.\n\n' +
    'When should it be sent?\n' +
    '• Send <code>now</code> to dispatch immediately\n' +
    '• Or a date in <code>DD.MM HH:mm</code> format (server timezone)',
    { reply_markup: cancelKeyboard }
  )
})

broadcastNewDate.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim()
  let scheduledAt

  if (text.toLowerCase() === 'now') {
    scheduledAt = new Date()
  } else {
    const m = moment(text, 'DD.MM HH:mm', true)
    if (!m.isValid()) {
      return ctx.replyWithHTML(
        '❌ Invalid date — use <code>DD.MM HH:mm</code> or <code>now</code>.',
        { reply_markup: cancelKeyboard }
      )
    }
    // Operator picks "12.01 09:00" in late December → treat as next year.
    if (m.isBefore(moment())) m.add(1, 'year')
    scheduledAt = m.toDate()
  }

  ctx.session.scene.scheduledAt = scheduledAt
  return ctx.scene.enter('broadcastNewAudience')
})

broadcastNewDate.action('broadcast:new:cancel', (ctx) => exitScene(ctx, '✖️ Cancelled.'))

// ───────────────────────────────────────────────────────────────────────
// Scene: audience
// ───────────────────────────────────────────────────────────────────────
const broadcastNewAudience = new Scene('broadcastNewAudience')

broadcastNewAudience.enter(async (ctx) => {
  const { scheduledAt } = ctx.session.scene
  await ctx.replyWithHTML(
    `📅 Scheduled for: <code>${moment(scheduledAt).format('DD MMM YYYY HH:mm')}</code>\n\n` +
    'Pick the audience:',
    { reply_markup: audienceKeyboard() }
  )
})

broadcastNewAudience.action(/^broadcast:new:audience:(.+)$/, async (ctx) => {
  const key = ctx.match[1]
  const audience = broadcast.audiences.get(key)
  if (!audience) {
    return ctx.answerCbQuery('Unknown audience', true).catch(() => {})
  }
  await ctx.answerCbQuery('Counting…').catch(() => {})

  // Count is cached for 5 min in broadcast/audiences.js; the first pick may
  // still take several seconds on big collections. If it times out (mongo
  // maxTimeMS), proceed with null — materialization at dispatch time
  // computes the real total, and the wizard makes it clear the figure is
  // unknown.
  let count = null
  try {
    count = await audience.count()
  } catch (err) {
    log.warn(`audience count failed (${key}): ${err.message}`)
    await ctx.replyWithHTML(
      '⚠️ Could not count audience right now (DB busy or query timed out).\n' +
      'You can still publish — actual count is computed at dispatch time.'
    ).catch(() => {})
  }

  ctx.session.scene.audience = key
  ctx.session.scene.audienceCount = count
  ctx.session.scene.audienceLabel = audience.label
  return ctx.scene.enter('broadcastNewConfirm')
})

broadcastNewAudience.action('broadcast:new:cancel', (ctx) => exitScene(ctx, '✖️ Cancelled.'))

// Fallback for stray text while waiting for the audience pick.
broadcastNewAudience.on('message', async (ctx) => {
  await ctx.replyWithHTML('Use the buttons above to pick an audience.', {
    reply_markup: audienceKeyboard()
  })
})

// ───────────────────────────────────────────────────────────────────────
// Scene: confirm
// ───────────────────────────────────────────────────────────────────────
const broadcastNewConfirm = new Scene('broadcastNewConfirm')

broadcastNewConfirm.enter(async (ctx) => {
  const { name, message, scheduledAt, audienceLabel, audienceCount } = ctx.session.scene

  // Render the post first so the operator visually confirms what users will
  // actually receive (media, buttons, link previews — all 1:1 with dispatch).
  try {
    await broadcast.renderPreview(ctx.telegram, ctx.chat.id, message)
  } catch (err) {
    log.error('confirm preview failed:', err.message)
    await ctx.replyWithHTML(
      `⚠️ Preview failed: <code>${escapeHTML(err.message || 'unknown')}</code>\n` +
      'You can still publish, but verify the captured payload is intact.'
    )
  }

  const audienceLine = audienceCount === null || audienceCount === undefined
    ? `<b>Audience:</b> ${escapeHTML(audienceLabel)} — <i>count unavailable, will be computed at dispatch</i>`
    : `<b>Audience:</b> ${escapeHTML(audienceLabel)} — <b>${audienceCount.toLocaleString()}</b> users`

  const lines = [
    '☝️ <i>Preview above — what users will receive.</i>',
    '',
    '<b>📋 Confirm broadcast</b>',
    `<b>Name:</b> ${escapeHTML(name)}`,
    audienceLine,
    `<b>Scheduled:</b> <code>${moment(scheduledAt).format('DD MMM YYYY HH:mm')}</code>`,
    '',
    audienceCount === 0
      ? '⚠️ <i>No users match this audience.</i>'
      : 'Ready to publish?'
  ]

  await ctx.replyWithHTML(lines.join('\n'), { reply_markup: confirmKeyboard })
})

broadcastNewConfirm.action('broadcast:new:publish', async (ctx) => {
  const draft = ctx.session.scene
  if (!draft || !draft.name || !draft.message || !draft.scheduledAt || !draft.audience) {
    await ctx.answerCbQuery('Incomplete draft', true).catch(() => {})
    return exitScene(ctx)
  }
  await ctx.answerCbQuery().catch(() => {})

  try {
    const doc = await ctx.db.Broadcast.create({
      name: draft.name,
      message: draft.message,
      audience: {
        type: draft.audience,
        snapshotCount: draft.audienceCount
      },
      scheduledAt: draft.scheduledAt,
      status: broadcast.STATUS.QUEUED,
      createdBy: ctx.session.userInfo && ctx.session.userInfo._id
    })

    await ctx.replyWithHTML(
      `✅ Broadcast <b>${escapeHTML(draft.name)}</b> queued.\n` +
      `<i>ID:</i> <code>${doc._id}</code>`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.callbackButton('📊 View status', `admin:messaging:status:${doc._id}`)],
          [Markup.callbackButton('📣 Broadcasts', 'admin:messaging')]
        ])
      }
    )
  } catch (err) {
    log.error('failed to persist broadcast:', err.stack || err.message)
    await ctx.replyWithHTML('❌ Failed to save broadcast. Check the logs.').catch(() => {})
  }

  return exitScene(ctx)
})

broadcastNewConfirm.action('broadcast:new:cancel', (ctx) => exitScene(ctx, '✖️ Cancelled.'))

module.exports = [
  broadcastNewName,
  broadcastNewMessage,
  broadcastNewDate,
  broadcastNewAudience,
  broadcastNewConfirm
]
