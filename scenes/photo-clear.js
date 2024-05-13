const Scene = require('telegraf/scenes/base')
const sharp = require('sharp')
const Queue = require('bull')
const {
  showGramAds
} = require('../utils')

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
        ],
        [
          {
            text: ctx.i18n.t('scenes.photoClear.web_app'),
            web_app: {
              url: 'https://bot.lyo.su/remove-background-web/',
            }
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

  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1]

  const fileUrl = await ctx.telegram.getFileLink(photo.file_id)

  let model = 'silueta'
  if (ctx.session.clerType === 'anime') {
    model = 'anime-seg'
  } else if (ctx.session.clerType === 'general') {
    model = 'isnet-general-use'
  }

  let priority = 10
  if (ctx.i18n.locale() === 'ru') priority = 15

  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Timeout'))
    }, 1000 * 30)
  })

  const job = await removebgQueue.add({
    fileUrl,
    model
  }, {
    priority,
    attempts: 1,
    removeOnComplete: true
  })

  const finish = await Promise.race([job.finished(), timeoutPromise]).catch(err => {
    return {
      error: err.message
    }
  })

  if (finish.content) {
    const trimBuffer = await sharp(Buffer.from(finish.content, 'base64'))
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
    console.error(finish.error)
    ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error'))
  }
})

module.exports = [
  photoClearSelect,
  photoClear
]
