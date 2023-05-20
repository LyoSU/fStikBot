const Scene = require('telegraf/scenes/base')
const sharp = require('sharp')
const Queue = require('bull')

const removebgQueue = new Queue('removebg', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD
  }
})

const photoClearSelect = new Scene('photoClearSelect')

photoClearSelect.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.choose_model'), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: ctx.i18n.t('scenes.photoClear.model.ordinary'),
            callback_data: 'model:ordinary'
          }
        ],
        [
          {
            text: ctx.i18n.t('scenes.photoClear.model.general'),
            callback_data: 'model:general'
          }
        ],
        [
          {
            text: ctx.i18n.t('scenes.photoClear.model.anime'),
            callback_data: 'model:anime'
          }
        ]
      ]
    }
  })
})

photoClearSelect.action(/model:(ordinary|general|anime)/, async (ctx) => {
  const [, model] = ctx.match

  ctx.session.clerType = model

  await ctx.scene.enter('photoClear')
})

const photoClear = new Scene('photoClear')

photoClear.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  await ctx.replyWithHTML(ctx.i18n.t(`scenes.photoClear.${ctx.session.clerType === 'anime' ? 'enter_anime' : 'enter'}`), {
    reply_markup: {
      keyboard: [
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ],
      resize_keyboard: true
    }
  })
})

photoClear.on('photo', async (ctx) => {
  ctx.replyWithChatAction('upload_document')

  const photo = ctx.message.photo[ctx.message.photo.length - 1]

  const fileUrl = await ctx.telegram.getFileLink(photo.file_id)

  let model = 'silueta'
  if (ctx.session.clerType === 'anime') {
    model = 'anime-seg'
  } else if (ctx.session.clerType === 'general') {
    model = 'isnet-general-use'
  }

  let priority = 10
  if (ctx.session.userInfo.premium) priority = 5
  else if (ctx.i18n.locale() === 'ru') priority = 15

  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Timeout'))
    }, 1000 * 10)
  })

  const jobPromise = removebgQueue.add({
    fileUrl,
    model
  }, {
    priority,
    attempts: 1,
    removeOnComplete: true
  })

  const { content } = await Promise.race([jobPromise, timeoutPromise]).catch(() => {})

  if (content) {
    const trimBuffer = await sharp(Buffer.from(content, 'base64'))
      .trim()
      .webp()
      .toBuffer()

    ctx.replyWithDocument({
      source: trimBuffer,
      filename: `${model}_${photo.file_unique_id}.webp`
    }, {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: ctx.i18n.t('scenes.photoClear.add_to_set_btn'),
              callback_data: 'add_sticker'
            }
          ]
        ]
      }
    })
  } else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error'))
  }
})

module.exports = [
  photoClearSelect,
  photoClear
]
