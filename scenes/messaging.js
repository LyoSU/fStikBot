const mongoose = require('mongoose')
const Redis = require('ioredis')
const Markup = require('telegraf/markup')
const Scene = require('telegraf/scenes/base')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

const redis = new Redis()

const adminMessagingName = new Scene('adminMessagingName')

adminMessagingName.enter(async (ctx) => {
  const resultText = ctx.i18n.t('admin.messaging.create.name')

  const replyMarkup = Markup.inlineKeyboard([
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

adminMessagingName.on('text', async (ctx) => {
  if (ctx.session.scene.edit) {
    const messaging = await ctx.db.Messaging.findById(ctx.session.scene.edit)

    messaging.name = ctx.message.text
    await messaging.save()

    const resultText = ctx.i18n.t('admin.messaging.status.name_changed')

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
        Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
      ]
    ])

    await ctx.replyWithHTML(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(() => {})
  } else {
    ctx.session.scene.name = ctx.message.text
    await ctx.scene.enter('adminMessagingMessageData')
  }
})

const parseUrlButton = (text) => {
  const inlineKeyboard = []

  if (text) {
    text.split('\n').forEach((line) => {
      const linelButton = []

      line.split('|').forEach((row) => {
        const data = row.split(' - ')
        if (data[0] && data[1]) {
          const name = data[0].trim()
          const url = data[1].trim()

          linelButton.push(Markup.urlButton(name, url))
        }
      })

      inlineKeyboard.push(linelButton)
    })
  }

  return inlineKeyboard
}

const adminMessagingMessageData = new Scene('adminMessagingMessageData')

adminMessagingMessageData.enter(async (ctx) => {
  if (ctx.session.scene.message) {
    const urlButton = parseUrlButton(ctx.session.scene.keyboard)

    let inlineKeyboard = []

    inlineKeyboard = inlineKeyboard.concat(urlButton)

    inlineKeyboard = inlineKeyboard.concat([
      [
        Markup.callbackButton(ctx.i18n.t('admin.messaging.create.add_url'), 'admin:messaging:add_url')
      ],
      [
        Markup.callbackButton(ctx.i18n.t('admin.messaging.create.continue'), 'admin:messaging:continue')
      ],
      [
        Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
        Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
      ]
    ])

    const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

    const method = replicators.copyMethods[ctx.session.scene.message.type]
    const opts = Object.assign({}, ctx.session.scene.message.data, {
      chat_id: ctx.chat.id,
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })

    await ctx.telegram.callApi(method, opts).catch(console.error)
  } else {
    const resultText = ctx.i18n.t('admin.messaging.create.send_message')

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
        Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
      ]
    ])

    await ctx.replyWithHTML(resultText, {
      reply_markup: replyMarkup
    })
  }
})

adminMessagingMessageData.action(/admin:messaging:add_url/, async (ctx) => ctx.scene.enter('adminMessagingMessageUrl'))

adminMessagingMessageData.on('message', async (ctx) => {
  const message = ctx.message
  const messageType = Object.keys(replicators.copyMethods).find((type) => message[type])
  const messageData = replicators[messageType](message)

  ctx.session.scene.message = { type: messageType, data: messageData }

  ctx.scene.enter('adminMessagingMessageData')
})

const adminMessagingMessageUrl = new Scene('adminMessagingMessageUrl')

adminMessagingMessageUrl.enter(async (ctx) => {
  const resultText = ctx.i18n.t('admin.messaging.create.add_url_info', {
    current: ctx.session.scene.keyboard
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    reply_markup: replyMarkup
  })
})

adminMessagingMessageUrl.on('text', async (ctx) => {
  ctx.session.scene.keyboard = ctx.message.text
  ctx.scene.enter('adminMessagingMessageData')
})

adminMessagingMessageData.action(/admin:messaging:continue/, async (ctx) => {
  if (ctx.session.scene.edit) ctx.scene.enter('adminMessagingMessageEdit')
  else ctx.scene.enter('adminMessagingMessageDate')
})

const adminMessagingSelectDate = new Scene('adminMessagingMessageDate')

adminMessagingSelectDate.enter(async (ctx) => {
  const resultText = ctx.i18n.t('admin.messaging.create.date')

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    reply_markup: replyMarkup
  })
})

adminMessagingSelectDate.on('text', async (ctx) => {
  const date = moment(ctx.message.text, 'DD.MM HH:mm')

  let resultText = ''
  let inlineKeyboard = []

  if (date.isValid()) {
    ctx.session.scene.date = date

    resultText = ctx.i18n.t('admin.messaging.create.date_format', {
      date: date.format('DD.MM HH:mm')
    })

    inlineKeyboard = [
      Markup.callbackButton(ctx.i18n.t('admin.messaging.create.continue'), 'admin:messaging:continue')
    ]
  } else {
    resultText = ctx.i18n.t('admin.messaging.create.date_invalid')
  }

  const replyMarkup = Markup.inlineKeyboard([
    inlineKeyboard,
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminMessagingSelectDate.action(/admin:messaging:continue/, async (ctx) => ctx.scene.enter('adminMessagingSelectGroup'))

const adminMessagingSelectGroup = new Scene('adminMessagingSelectGroup')

adminMessagingSelectGroup.enter(async (ctx) => {
  const resultText = ctx.i18n.t('admin.messaging.create.group_select')

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton(ctx.i18n.t('admin.messaging.create.group_type.all'), 'admin:messaging:group:all')],
    [Markup.callbackButton(ctx.i18n.t('admin.messaging.create.group_type.ru'), 'admin:messaging:group:ru')],
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

adminMessagingSelectGroup.action(/admin:messaging:group:(.*)/, async (ctx) => {
  ctx.session.scene.type = ctx.match[1]

  ctx.scene.enter('adminMessagingСonfirmation')
})

const adminMessagingСonfirmation = new Scene('adminMessagingСonfirmation')

adminMessagingСonfirmation.enter(async (ctx) => {
  let findUsers = {}

  if (ctx.session.scene.type === 'all') {
    findUsers = await ctx.db.User.count({
      blocked: { $ne: true }
    })
  } else if (ctx.session.scene.type === 'ru') {
    findUsers = await ctx.db.User.count({
      blocked: { $ne: true },
      premium: { $ne: true },
      locale: 'ru',
      updatedAt: { $gte: moment().subtract(1, 'months') }
    })
  }

  const resultText = ctx.i18n.t('admin.messaging.create.found', {
    userCount: findUsers
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.messaging.create.back'), 'admin:messaging:select_group'),
      Markup.callbackButton(ctx.i18n.t('admin.messaging.create.continue'), 'admin:messaging:publish')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    reply_markup: replyMarkup
  })
})

const adminMessagingMessageEdit = new Scene('adminMessagingMessageEdit')

adminMessagingMessageEdit.enter(async (ctx) => {
  const messaging = await ctx.db.Messaging.findById(ctx.session.scene.edit)

  if (ctx.session.scene.message.type === messaging.message.type) {
    messaging.message = ctx.session.scene.message
    messaging.editStatus = 1
    await messaging.save()

    redis.set(`messaging:${messaging.id}:edit_state`, 0)

    const resultText = ctx.i18n.t('admin.messaging.edit.started', {
      name: messaging.name
    })

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton(ctx.i18n.t('admin.messaging.create.status'), `admin:messaging:status:${messaging.id}`)
      ],
      [
        Markup.callbackButton(ctx.i18n.t('admin.menu.messaging'), 'admin:messaging'),
        Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
      ]
    ])

    await ctx.replyWithHTML(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(() => {})

    ctx.session.scene = null
    ctx.scene.leave()
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('admin.messaging.edit.wrong_type', {
      type: ctx.session.scene.message.type,
      originalType: messaging.message.type
    }))
    ctx.session.scene.message = messaging.message
    ctx.scene.enter('adminMessagingMessageData')
  }
})

const adminMessagingPublish = new Scene('adminMessagingPublish')

adminMessagingPublish.enter(async (ctx) => {
  const urlButton = parseUrlButton(ctx.session.scene.keyboard)

  let inlineKeyboard = []

  inlineKeyboard = inlineKeyboard.concat(urlButton)

  ctx.session.scene.message.data.reply_markup = Markup.inlineKeyboard(inlineKeyboard)

  let usersCursor
  if (ctx.session.scene.type === 'all') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true }
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'ru') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      premium: { $ne: true },
      locale: 'ru',
      updatedAt: { $gte: moment().subtract(1, 'months') }
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  }

  // const users = []
  const messagingId = mongoose.Types.ObjectId()
  const key = `messaging:${messagingId}`

  let usersCount = 0

  for (let user = await usersCursor.next(); user != null; user = await usersCursor.next()) {
    await redis.rpush(key + ':users', [user.telegram_id])
    usersCount++
  }

  const messaging = new ctx.db.Messaging()

  Object.assign(messaging, {
    _id: messagingId,
    creator: ctx.session.user,
    name: ctx.session.scene.name,
    message: ctx.session.scene.message,
    result: {
      total: usersCount
    },
    date: ctx.session.scene.date
  })

  messaging.save()

  const resultText = ctx.i18n.t('admin.messaging.create.publish', {
    name: ctx.session.scene.name
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.messaging.create.status'), `admin:messaging:status:${messagingId}`)
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

  ctx.session.scene = null
  ctx.scene.leave()
})

module.exports = [
  adminMessagingName,
  adminMessagingMessageData,
  adminMessagingMessageUrl,
  adminMessagingSelectDate,
  adminMessagingSelectGroup,
  adminMessagingСonfirmation,
  adminMessagingMessageEdit,
  adminMessagingPublish
]
