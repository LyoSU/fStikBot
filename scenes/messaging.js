const mongoose = require('mongoose')
const Redis = require('ioredis')
const Markup = require('telegraf/markup')
const Scene = require('telegraf/scenes/base')
const replicators = require('telegraf/core/replicators')
const moment = require('moment')

const redis = new Redis()

const adminMessagingName = new Scene('adminMessagingName')

adminMessagingName.enter(async (ctx) => {
  const resultText = 'Enter a name for your messaging campaign'

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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

    const resultText = 'Name changed successfully'

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton('Messaging', 'admin:messaging'),
        Markup.callbackButton('Admin', 'admin:back')
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
        Markup.callbackButton('Add URL button', 'admin:messaging:add_url')
      ],
      [
        Markup.callbackButton('Continue', 'admin:messaging:continue')
      ],
      [
        Markup.callbackButton('Messaging', 'admin:messaging'),
        Markup.callbackButton('Admin', 'admin:back')
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
    const resultText = 'Please send the message you want to send to users'

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton('Messaging', 'admin:messaging'),
        Markup.callbackButton('Admin', 'admin:back')
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
  const resultText = `Send URL buttons in format: Button name - URL
You can add multiple buttons in one line with | separator
You can add multiple lines for different rows

${ctx.session.scene.keyboard ? 'Current buttons:\n' + ctx.session.scene.keyboard : ''}`

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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
  const resultText = 'Enter the date when the message should be sent in format DD.MM HH:mm'

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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

    resultText = `Selected date: ${date.format('DD.MM HH:mm')}`

    inlineKeyboard = [
      Markup.callbackButton('Continue', 'admin:messaging:continue')
    ]
  } else {
    resultText = 'Invalid date format. Please use DD.MM HH:mm'
  }

  const replyMarkup = Markup.inlineKeyboard([
    inlineKeyboard,
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminMessagingSelectDate.action(/admin:messaging:continue/, async (ctx) => ctx.scene.enter('adminMessagingSelectGroup'))

const adminMessagingSelectGroup = new Scene('adminMessagingSelectGroup')

adminMessagingSelectGroup.enter(async (ctx) => {
  const resultText = 'Select the group of users to send the message to'

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('All users', 'admin:messaging:group:all')],
    [Markup.callbackButton('Russian-speaking users', 'admin:messaging:group:ru')],
    [Markup.callbackButton('Ukrainian-speaking users', 'admin:messaging:group:uk')],
    [Markup.callbackButton('English-speaking users', 'admin:messaging:group:en')],
    [Markup.callbackButton('🌐 Other languages', 'admin:messaging:group:other')],
    [Markup.callbackButton('🇬🇧 Active EN users with packs', 'admin:messaging:group:en_active')],
    [Markup.callbackButton('🌐 Active users with other languages', 'admin:messaging:group:other_active')],
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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
  const monthAgo = moment().subtract(1, 'month')
  const threeMonthsAgo = moment().subtract(3, 'months')

  if (ctx.session.scene.type === 'all') {
    findUsers = await ctx.db.User.countDocuments({
      blocked: { $ne: true },
      locale: { $ne: 'ru' }
    })
  } else if (ctx.session.scene.type === 'ru') {
    findUsers = await ctx.db.User.countDocuments({
      blocked: { $ne: true },
      premium: { $ne: true },
      locale: 'ru'
      // updatedAt: { $gte: moment().subtract(1, 'months') }
    })
  } else if (ctx.session.scene.type === 'uk') {
    findUsers = await ctx.db.User.countDocuments({
      blocked: { $ne: true },
      locale: 'uk'
    })
  } else if (ctx.session.scene.type === 'en') {
    findUsers = await ctx.db.User.countDocuments({
      blocked: { $ne: true },
      locale: 'en'
    })
  } else if (ctx.session.scene.type === 'en_active') {
    // Start from stickersets - find owners with >=2 packs, then filter by user conditions
    const pipeline = [
      { $group: { _id: '$owner', packCount: { $sum: 1 } } },
      { $match: { packCount: { $gte: 2 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.blocked': { $ne: true },
          'user.banned': { $ne: true },
          'user.locale': 'en',
          'user.updatedAt': { $gte: monthAgo.toDate() },
          'user.createdAt': { $lte: threeMonthsAgo.toDate() }
        }
      },
      { $count: 'totalUsers' }
    ]

    const result = await ctx.db.StickerSet.aggregate(pipeline).allowDiskUse(true)
    findUsers = result.length > 0 ? result[0].totalUsers : 0
  } else if (ctx.session.scene.type === 'other') {
    findUsers = await ctx.db.User.countDocuments({
      blocked: { $ne: true },
      banned: { $ne: true },
      locale: { $nin: ['en', 'ru', 'uk'] }
    })
  } else if (ctx.session.scene.type === 'other_active') {
    // Start from stickersets - find owners with >=2 packs, then filter by user conditions
    const pipeline = [
      { $group: { _id: '$owner', packCount: { $sum: 1 } } },
      { $match: { packCount: { $gte: 2 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.blocked': { $ne: true },
          'user.banned': { $ne: true },
          'user.locale': { $nin: ['en', 'ru', 'uk'] },
          'user.updatedAt': { $gte: monthAgo.toDate() },
          'user.createdAt': { $lte: threeMonthsAgo.toDate() }
        }
      },
      { $count: 'totalUsers' }
    ]

    const result = await ctx.db.StickerSet.aggregate(pipeline).allowDiskUse(true)
    findUsers = result.length > 0 ? result[0].totalUsers : 0
  }

  const resultText = `Good! Found ${findUsers} users`

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('Back to group selection', 'admin:messaging:select_group'),
      Markup.callbackButton('Continue', 'admin:messaging:publish')
    ],
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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

    const resultText = `Editing for messaging "${messaging.name}" started`

    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.callbackButton('View status', `admin:messaging:status:${messaging.id}`)
      ],
      [
        Markup.callbackButton('Messaging', 'admin:messaging'),
        Markup.callbackButton('Admin', 'admin:back')
      ]
    ])

    await ctx.replyWithHTML(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(() => {})

    ctx.session.scene = null
    ctx.scene.leave()
  } else {
    await ctx.replyWithHTML(`Message type mismatch. Current: ${ctx.session.scene.message.type}, Original: ${messaging.message.type}`)
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
  const monthAgo = moment().subtract(1, 'month')
  const threeMonthsAgo = moment().subtract(3, 'months')

  if (ctx.session.scene.type === 'all') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      locale: { $ne: 'ru' }
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'ru') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      premium: { $ne: true },
      locale: 'ru'
      // updatedAt: { $gte: moment().subtract(1, 'months') }
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'uk') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      locale: 'uk'
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'en') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      locale: 'en'
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'en_active') {
    // Start from stickersets - more efficient with owner index
    usersCursor = ctx.db.StickerSet.aggregate([
      { $group: { _id: '$owner', packCount: { $sum: 1 } } },
      { $match: { packCount: { $gte: 2 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.blocked': { $ne: true },
          'user.banned': { $ne: true },
          'user.locale': 'en',
          'user.updatedAt': { $gte: monthAgo.toDate() },
          'user.createdAt': { $lte: threeMonthsAgo.toDate() }
        }
      },
      {
        $project: {
          _id: '$user._id',
          telegram_id: '$user.telegram_id'
        }
      }
    ]).allowDiskUse(true).cursor({ batchSize: 1000 })
  } else if (ctx.session.scene.type === 'other') {
    usersCursor = await ctx.db.User.find({
      blocked: { $ne: true },
      banned: { $ne: true },
      locale: { $nin: ['en', 'ru', 'uk'] }
    }).select({ _id: 1, telegram_id: 1 }).cursor()
  } else if (ctx.session.scene.type === 'other_active') {
    // Start from stickersets - more efficient with owner index
    usersCursor = ctx.db.StickerSet.aggregate([
      { $group: { _id: '$owner', packCount: { $sum: 1 } } },
      { $match: { packCount: { $gte: 2 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.blocked': { $ne: true },
          'user.banned': { $ne: true },
          'user.locale': { $nin: ['en', 'ru', 'uk'] },
          'user.updatedAt': { $gte: monthAgo.toDate() },
          'user.createdAt': { $lte: threeMonthsAgo.toDate() }
        }
      },
      {
        $project: {
          _id: '$user._id',
          telegram_id: '$user.telegram_id'
        }
      }
    ]).allowDiskUse(true).cursor({ batchSize: 1000 })
  }

  // const users = []
  const messagingId = mongoose.Types.ObjectId()
  const key = `messaging:${messagingId}`

  let usersCount = 0
  const BATCH_SIZE = 1000

  let batch = []
  for (let user = await usersCursor.next(); user != null; user = await usersCursor.next()) {
    batch.push(user.telegram_id)
    usersCount++

    if (batch.length >= BATCH_SIZE) {
      await redis.rpush(key + ':users', batch)
      batch = []
    }
  }
  // Push remaining users
  if (batch.length > 0) {
    await redis.rpush(key + ':users', batch)
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

  await messaging.save()

  const resultText = `Message "${ctx.session.scene.name}" has been created and scheduled`

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('View status', `admin:messaging:status:${messagingId}`)
    ],
    [
      Markup.callbackButton('Messaging', 'admin:messaging'),
      Markup.callbackButton('Admin', 'admin:back')
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
