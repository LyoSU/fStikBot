const Scene = require('telegraf/scenes/base')
const sharp = require('sharp')
const {
  showGramAds
} = require('../utils')
const { removebgQueue } = require('../utils/queues')

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
        // [
        //   {
        //     text: ctx.i18n.t('scenes.photoClear.model.birefnet_general'),
        //     callback_data: 'model:birefnet_general'
        //   }
        // ],
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
              url: 'https://bot.lyo.su/remove-background-web/'
            }
          }
        ]
      ]
    }
  })
})

photoClearSelect.action(/model:(ordinary|general|birefnet_general|anime)/, async (ctx) => {
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

// A PNG sent "as a file" is the common way to keep transparency, and it used
// to fall straight through the scene into the global sticker handler — the
// image landed in the user's pack instead of getting its background removed.
const resolveSource = (message) => {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]
    return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id }
  }

  if (message.document) {
    const mime = message.document.mime_type || ''
    if (!mime.startsWith('image/') || /heic|heif/.test(mime)) return null
    return { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id }
  }

  return null
}

photoClear.on(['photo', 'document'], async (ctx) => {
  const source = resolveSource(ctx.message)

  if (!source) {
    return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.file_type.unknown'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  ctx.replyWithChatAction('upload_document').catch(() => {}) // chat action is best-effort UI, fire-and-forget OK

  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  let fileUrl
  try {
    fileUrl = await ctx.telegram.getFileLink(source.fileId)
  } catch (err) {
    return ctx.replyWithHTML(ctx.i18n.t(err.message?.includes('file is too big') ? 'error.file_too_big' : 'error.download'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  let model = 'silueta'

  if (ctx.session.clerType === 'anime') {
    model = 'isnet-anime'
  } else if (ctx.session.clerType === 'general') {
    model = 'isnet-general-use'
  } else if (ctx.session.clerType === 'birefnet_general') {
    model = 'birefnet-general'
  } else if (ctx.session.clerType === 'silueta' || ctx.session.clerType === 'ordinary') {
    model = 'silueta'
  }

  let priority = 10
  if (ctx.i18n.locale() === 'ru') priority = 15

  let job
  try {
    job = await removebgQueue.add({
      fileUrl,
      model
    }, {
      priority,
      attempts: 1,
      removeOnComplete: true,
      // Failed jobs otherwise accumulate in Redis forever.
      removeOnFail: true
    })
  } catch (err) {
    // Queue stub (REDIS_HOST unset) rejects with QUEUE_DISABLED; surface
    // that to the user as "feature temporarily unavailable" instead of a
    // generic error.
    if (err.code === 'QUEUE_DISABLED') {
      return ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error_queue_disabled'))
    }
    console.error('removebg enqueue failed:', err.message)
    return ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error'))
  }

  // Resolve-with-sentinel timeout instead of reject: Promise.race losers
  // live on until they settle, and a rejecting loser becomes an unhandled
  // rejection once the race has a winner. Returning a marker object keeps
  // the promise harmless and lets the caller branch on it explicitly.
  const TIMEOUT = Symbol('timeout')
  let timer
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), 1000 * 30)
  })

  // Attach the .catch BEFORE racing — otherwise if job.finished() rejects
  // after the timeout has already won, the rejection is unhandled.
  const jobPromise = job.finished().catch(err => ({ error: err.message }))
  const raceResult = await Promise.race([jobPromise, timeoutPromise])
  clearTimeout(timer)

  const finish = raceResult === TIMEOUT ? { error: 'Timeout' } : raceResult

  if (finish.content) {
    const trimBuffer = await sharp(Buffer.from(finish.content, 'base64'))
      .trim()
      .webp()
      .toBuffer()

    await ctx.replyWithDocument({
      source: trimBuffer,
      filename: `${model}_${source.fileUniqueId}.webp`
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
    console.error('photoClear job error:', finish.error)
    const i18nKey = finish.error === 'Timeout'
      ? 'scenes.photoClear.error_timeout'
      : 'scenes.photoClear.error'
    await ctx.replyWithHTML(ctx.i18n.t(i18nKey))
  }
})

module.exports = [
  photoClearSelect,
  photoClear
]
