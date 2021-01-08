const Queue = require('bull')
const Markup = require('telegraf/markup')
const Scene = require('telegraf/scenes/base')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

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

  if (['all'].includes(ctx.session.scene.type)) {
    ctx.scene.enter('adminMessagingСonfirmation')
  }
})

const adminMessagingСonfirmation = new Scene('adminMessagingСonfirmation')

adminMessagingСonfirmation.enter(async (ctx) => {
  let findUsers = {}

  if (ctx.session.scene.type === 'all') {
    findUsers = await ctx.db.User.find({
      blocked: { $ne: true }
    }).cursor()
  }

  const userList = ''

  ctx.session.scene.users = []

  for (let user = await findUsers.next(); user != null; user = await findUsers.next()) {
    ctx.session.scene.users.push(user.telegram_id)
  }

  const resultText = ctx.i18n.t('admin.messaging.create.found', {
    userCount: ctx.session.scene.users.length,
    userList
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

  const messaging = new ctx.db.Messaging()

  Object.assign(messaging, {
    creator: ctx.session.user,
    name: ctx.session.scene.name,
    message: ctx.session.scene.message,
    result: {
      waiting: ctx.session.scene.users.length
    },
    date: ctx.session.scene.date
  })

  messaging.save().then((messaging) => {
    const jobName = `messaging_${messaging.id}`

    const queue = new Queue(jobName, {
      limiter: {
        max: ctx.config.messaging.limit.max || 10,
        duration: ctx.config.messaging.limit.duration || 1000
      }
    })

    const size = 10000
    const users = []
    for (let i = 0; i < Math.ceil(ctx.session.scene.users.length / size); i++) {
      users[i] = ctx.session.scene.users.slice((i * size), (i * size) + size)
    }

    queue.addBulk(users.map((chatId) => { return { data: chatId } }))
  })

  const resultText = ctx.i18n.t('admin.messaging.create.publish', {
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
