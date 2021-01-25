const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

const composer = new Composer()

composer.action(/admin:messaging:select_group/, async (ctx) => ctx.scene.enter('adminMessagingSelectGroup'))
composer.action(/admin:messaging:publish/, async (ctx) => ctx.scene.enter('adminMessagingPublish'))

composer.action(/admin:messaging:view:(.*)/, async (ctx, next) => {
  const messaging = await ctx.db.Messaging.findOne({ _id: ctx.match[1] })

  if (messaging) {
    const method = replicators.copyMethods[messaging.message.type]
    const opts = Object.assign(messaging.message.data, {
      chat_id: ctx.chat.id
    })

    ctx.telegram.callApi(method, opts)
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

  messaging.status = 2
  messaging.result = {
    waiting: 0
  }
  messaging.save()

  const resultText = ctx.i18n.t('admin.messaging.canceled', {
    name: messaging.name
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.messaging.status.update'), `admin:messaging:status:${ctx.match[1]}`)
    ],
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

composer.action(/admin:messaging:list:(.*):(.*)/, async (ctx, next) => {
  const resultText = ctx.i18n.t('admin.messaging.list.info')

  let messagingQuery

  if (ctx.match[1] === 'archive') messagingQuery = { status: 2 }
  else messagingQuery = { status: { $lt: 2 } }

  const messagingTotal = await ctx.db.Messaging.countDocuments(messagingQuery)

  const pageCount = 10
  let page = parseInt(ctx.match[2])

  if (page <= 0) page = 1
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
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

composer.action(/admin:messaging:status:(.*)/, async (ctx, next) => {
  const messaging = await ctx.db.Messaging.findOne({ _id: ctx.match[1] }).populate('creator')

  let resultText, replyMarkup

  const statusTypes = ctx.i18n.t('admin.messaging.status.status_type').split('\n')

  if (messaging) {
    let creatorName = ctx.me
    if (messaging.creator) creatorName = messaging.creator.full_name

    let userErrors = ''

    for (const key in messaging.sendErrors) {
      const error = messaging.sendErrors[key]

      const userError = await ctx.db.User.findOne({ telegram_id: error.telegram_id }).populate('personal')

      userErrors += `<a href="tg://user?id=${error.telegram_id}">${userError.first_name}</a>\n`
    }

    resultText = ctx.i18n.t('admin.messaging.status.info', {
      name: messaging.name,
      creatorName,
      date: moment(messaging.date).format('DD.MM HH:mm'),
      createdAt: moment(messaging.createdAt).format('DD.MM HH:mm'),
      total: messaging.result.total,
      completed: messaging.result.state,
      left: messaging.result.total - messaging.result.state,
      error: messaging.result.error,
      userErrors,
      status: statusTypes[messaging.status]
    })

    let cancelButton = []
    if (messaging.status < 2) cancelButton = [Markup.callbackButton(ctx.i18n.t('admin.messaging.status.cancel'), `admin:messaging:cancel:${ctx.match[1]}`)]

    replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('admin.messaging.status.update'), `admin:messaging:status:${ctx.match[1]}`),
        Markup.callbackButton(ctx.i18n.t('admin.messaging.status.view'), `admin:messaging:view:${ctx.match[1]}`)
      ],
      [
        Markup.callbackButton(ctx.i18n.t('admin.messaging.status.edit'), `admin:messaging:edit:${ctx.match[1]}`),
        Markup.callbackButton(ctx.i18n.t('admin.messaging.status.change_name'), `admin:messaging:change_name:${ctx.match[1]}`)
      ],
      cancelButton,
      [
        Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
        Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
      ]
    ])
  }

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

composer.action(/admin:messaging:create/, async (ctx, next) => {
  ctx.scene.enter('adminMessagingName')
})

composer.action(/admin:messaging/, async (ctx, next) => {
  const resultText = ctx.i18n.t('admin.messaging.info')

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton(ctx.i18n.t('admin.messaging.menu.create'), 'admin:messaging:create')],
    [Markup.callbackButton(ctx.i18n.t('admin.messaging.menu.scheduled'), 'admin:messaging:list:scheduled:1')],
    [Markup.callbackButton(ctx.i18n.t('admin.messaging.menu.archive'), 'admin:messaging:list:archive:1')],
    [Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

module.exports = composer
