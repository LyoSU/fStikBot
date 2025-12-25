const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

const composer = new Composer()

composer.action(/admin:messaging:select_group/, async (ctx) => ctx.scene.enter('adminMessagingSelectGroup'))
composer.action(/admin:messaging:publish/, async (ctx) => ctx.scene.enter('adminMessagingPublish'))

composer.action(/admin:messaging:view:(.*)/, async (ctx, next) => {
  await ctx.answerCbQuery()

  const messaging = await ctx.db.Messaging.findOne({ _id: ctx.match[1] })

  if (messaging) {
    const method = replicators.copyMethods[messaging.message.type]
    const opts = Object.assign(messaging.message.data, {
      chat_id: ctx.chat.id
    })

    await ctx.telegram.callApi(method, opts).catch((error) => {
      console.error('Failed to send messaging preview:', error.message)
    })
  }
})

composer.action(/admin:messaging:edit:(.*)/, async (ctx, next) => {
  ctx.session.scene.edit = ctx.match[1]
  ctx.scene.enter('adminMessagingMessageData')
})

composer.action(/admin:messaging:change_name:(.*)/, async (ctx, next) => {
  ctx.session.scene.edit = ctx.match[1]
  ctx.scene.enter('adminMessagingName')
})

composer.action(/admin:messaging:cancel:(.*)/, async (ctx, next) => {
  const messaging = await ctx.db.Messaging.findOne({ _id: ctx.match[1] })

  if (!messaging) {
    return ctx.answerCbQuery('Messaging not found', true)
  }

  messaging.status = 2
  messaging.result = {
    waiting: 0
  }
  await messaging.save()

  const resultText = `Message ${messaging.name} canceled`

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('Show message status', `admin:messaging:status:${ctx.match[1]}`)
    ],
    [
      Markup.callbackButton('Back', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
    ]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

composer.action(/admin:messaging:list:(.*):(.*)/, async (ctx, next) => {
  const resultText = 'Messaging campaigns list'

  let messagingQuery

  if (ctx.match[1] === 'archive') messagingQuery = { status: 2 }
  else messagingQuery = { status: { $lt: 2 } }

  const messagingTotal = await ctx.db.Messaging.countDocuments(messagingQuery)

  const pageCount = 10
  let page = parseInt(ctx.match[2], 10) || 1

  if (page <= 0 || !Number.isFinite(page)) page = 1
  if (pageCount * page > messagingTotal) page = Math.ceil(messagingTotal / pageCount)

  const prevPage = page - 1
  const nextPage = page + 1

  let pageSkip = pageCount * (page - 1)
  if (pageSkip < 0) pageSkip = 0

  const messagingList = await ctx.db.Messaging.find(messagingQuery).sort({ createdAt: -1 }).skip(pageSkip).limit(pageCount)

  const messagingKeyboard = []

  Object.keys(messagingList).forEach((key) => {
    const messaging = messagingList[key]
    messagingKeyboard.push([Markup.callbackButton(messaging.name, `admin:messaging:status:${messaging.id}`)])
  })

  let inlineKeyboard = []

  const keyboardNavigation = []

  if (prevPage > 0) keyboardNavigation.push(Markup.callbackButton('◀️', `admin:messaging:list:${ctx.match[1]}:${prevPage}`))
  if (pageCount * page < messagingTotal) keyboardNavigation.push(Markup.callbackButton('▶️', `admin:messaging:list:${ctx.match[1]}:${nextPage}`))

  inlineKeyboard = inlineKeyboard.concat(messagingKeyboard)
  inlineKeyboard = inlineKeyboard.concat([keyboardNavigation])
  inlineKeyboard = inlineKeyboard.concat([
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
    ]
  ])

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

composer.action(/admin:messaging:status:(.*)/, async (ctx, next) => {
  const messaging = await ctx.db.Messaging.findOne({ _id: ctx.match[1] }).populate('creator', '_id telegram_id first_name').lean()

  let resultText, replyMarkup

  const statusTypes = ['📝 Draft', '⏳ In progress', '✅ Completed', '❌ Failed']
  const statusColors = ['🔵', '🟡', '🟢', '🔴']

  if (messaging) {
    // Calculate percentages for progress indicators
    const totalMessages = messaging.result.total || 0
    const sentMessages = messaging.result.state || 0
    const deliveredMessages = sentMessages - (messaging.result.error || 0)
    const errorMessages = messaging.result.error || 0

    const completionPercent = totalMessages > 0 ? Math.round((sentMessages / totalMessages) * 100) : 0
    const deliveryPercent = sentMessages > 0 ? Math.round((deliveredMessages / sentMessages) * 100) : 0
    const errorPercent = sentMessages > 0 ? Math.round((errorMessages / sentMessages) * 100) : 0

    // Create progress bar
    const progressBarLength = 10
    const filledBars = Math.round((completionPercent / 100) * progressBarLength)
    const progressBar = '▓'.repeat(filledBars) + '░'.repeat(progressBarLength - filledBars)

    // Format date nicely
    const scheduledDate = moment(messaging.date)
    const createdDate = moment(messaging.createdAt)
    const now = moment()

    const scheduledFormatted = scheduledDate.format('DD MMM YYYY [at] HH:mm')
    const scheduledRelative = scheduledDate.isAfter(now) ? `(${scheduledDate.fromNow()})` : ''
    const createdFormatted = createdDate.format('DD MMM YYYY [at] HH:mm')

    // Collect user errors in a cleaner way
    let userErrors = ''
    if (messaging.sendErrors && messaging.sendErrors.length > 0) {
      userErrors = '\n<b>📋 Last Error Details:</b>\n'
      const errorLimit = Math.min(5, messaging.sendErrors.length)

      for (let i = 0; i < errorLimit; i++) {
        const error = messaging.sendErrors[i]
        if (error && error.telegram_id) {
          userErrors += `• <a href="tg://user?id=${error.telegram_id}">User ${error.telegram_id}</a>: ${error.errorMessage || 'Unknown error'}\n`
        }
      }

      if (messaging.sendErrors.length > errorLimit) {
        userErrors += `<i>...and ${messaging.sendErrors.length - errorLimit} more errors</i>\n`
      }
    }

    resultText = '<b>📊 Message Campaign Status</b>\n\n'
    resultText += `<b>🏷 Name:</b> ${messaging.name}\n`
    resultText += `<b>⏰ Scheduled for:</b> ${scheduledFormatted} ${scheduledRelative}\n`
    resultText += `<b>🗓 Created on:</b> ${createdFormatted}\n`
    resultText += `<b>📊 Status:</b> ${statusColors[messaging.status] || '⚪️'} ${statusTypes[messaging.status] || 'Unknown'}\n\n`

    resultText += `<b>📈 Progress:</b> ${completionPercent}% ${progressBar}\n`
    resultText += `<b>📨 Total Recipients:</b> ${totalMessages.toLocaleString()}\n`
    resultText += `<b>✓ Processed:</b> ${sentMessages.toLocaleString()} (${completionPercent}%)\n`
    resultText += `<b>📬 Delivered:</b> ${deliveredMessages.toLocaleString()} (${deliveryPercent}%)\n`
    resultText += `<b>📭 Remaining:</b> ${(totalMessages - sentMessages).toLocaleString()}\n`
    resultText += `<b>⚠️ Errors:</b> ${errorMessages.toLocaleString()} (${errorPercent}%)\n`

    resultText += userErrors

    let cancelButton = []
    if (messaging.status < 2) {
      cancelButton = [Markup.callbackButton('❌ Cancel messaging', `admin:messaging:cancel:${ctx.match[1]}`)]
    }

    replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton('🔄 Refresh', `admin:messaging:status:${ctx.match[1]}`),
        Markup.callbackButton('👁 View message', `admin:messaging:view:${ctx.match[1]}`)
      ],
      [
        Markup.callbackButton('✏️ Edit message', `admin:messaging:edit:${ctx.match[1]}`),
        Markup.callbackButton('📝 Change name', `admin:messaging:change_name:${ctx.match[1]}`)
      ],
      cancelButton,
      [
        Markup.callbackButton('← Messaging', 'admin:messaging'),
        Markup.callbackButton('⚙️ Admin', 'admin:back')
      ]
    ])
  } else {
    resultText = '⚠️ Message not found'
    replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton('← Messaging', 'admin:messaging'),
        Markup.callbackButton('⚙️ Admin', 'admin:back')
      ]
    ])
  }

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
    disable_web_page_preview: true
  }).catch(() => {})
})

composer.action(/admin:messaging:create/, async (ctx, next) => {
  ctx.scene.enter('adminMessagingName')
})

composer.action(/admin:messaging/, async (ctx, next) => {
  const resultText = 'Messaging administration panel'

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('Create new messaging', 'admin:messaging:create')],
    [Markup.callbackButton('Scheduled messagings', 'admin:messaging:list:scheduled:1')],
    [Markup.callbackButton('Messaging archive', 'admin:messaging:list:archive:1')],
    [Markup.callbackButton('Back to admin', 'admin:back')]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

module.exports = composer
