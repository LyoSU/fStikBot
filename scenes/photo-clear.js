const Scene = require('telegraf/scenes/base')
const sharp = require('sharp')
const { showGramAds } = require('../utils')
const { removebgQueue } = require('../utils/queues')
const { runQueueJob } = require('../utils/queue-job')

const TIMEOUT_MS = 30 * 1000

// Background-removal models the worker knows, by the i18n key of their button.
const MODELS = {
  general: 'isnet-general-use',
  ordinary: 'silueta',
  anime: 'isnet-anime'
}
const DEFAULT_MODEL = 'general'

const photoClear = new Scene('photoClear')

const currentModel = (ctx) => (MODELS[ctx.session.scene?.clearModel] ? ctx.session.scene.clearModel : DEFAULT_MODEL)

const modelButtons = (ctx, callbackPrefix, { markCurrent }) => Object.keys(MODELS).map((key) => [{
  text: (markCurrent && key === currentModel(ctx) ? '✅ ' : '') + ctx.i18n.t(`scenes.photoClear.model.${key}`),
  callback_data: `${callbackPrefix}:${key}`
}])

// Straight to "send a photo" with a model that suits most pictures. Picking a
// model used to be a mandatory step before the user could send anything.
photoClear.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  ctx.session.scene = { clearModel: DEFAULT_MODEL }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.enter'), {
    reply_markup: {
      inline_keyboard: [
        ...modelButtons(ctx, 'clear_model', { markCurrent: true }),
        [{ text: ctx.i18n.t('scenes.photoClear.web_app'), web_app: { url: 'https://bot.lyo.su/remove-background-web/' } }]
      ]
    }
  })
})

photoClear.action(/^clear_model:(\w+)$/, async (ctx) => {
  if (!MODELS[ctx.match[1]]) return ctx.answerCbQuery()
  ctx.session.scene.clearModel = ctx.match[1]
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      ...modelButtons(ctx, 'clear_model', { markCurrent: true }),
      [{ text: ctx.i18n.t('scenes.photoClear.web_app'), web_app: { url: 'https://bot.lyo.su/remove-background-web/' } }]
    ]
  }).catch(() => {})
})

// A PNG sent "as a file" is the common way to keep transparency.
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

const removeBackground = async (ctx, source, replyToMessageId) => {
  const replyTo = { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true }
  const model = currentModel(ctx)

  ctx.replyWithChatAction('upload_document').catch(() => {})
  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  let fileUrl
  try {
    fileUrl = await ctx.telegram.getFileLink(source.fileId)
  } catch (err) {
    return ctx.replyWithHTML(ctx.i18n.t(err.message?.includes('file is too big') ? 'error.file_too_big' : 'error.download'), replyTo)
  }

  const outcome = await runQueueJob(removebgQueue, { fileUrl, model: MODELS[model] }, {
    priority: ctx.i18n.locale() === 'ru' ? 15 : 10,
    timeoutMs: TIMEOUT_MS
  })

  if (outcome.error) {
    const key = {
      disabled: 'scenes.photoClear.error_queue_disabled',
      timeout: 'scenes.photoClear.error_timeout'
    }[outcome.error] || 'scenes.photoClear.error'
    return ctx.replyWithHTML(ctx.i18n.t(key), replyTo)
  }

  // A real PNG, as the prompt promises (it used to be a .webp).
  const png = await sharp(Buffer.from(outcome.result.content, 'base64')).trim().png().toBuffer()

  // Kept so the result's "try another model" buttons can run it again.
  ctx.session.scene.clearSource = { ...source, replyToMessageId }

  await ctx.replyWithDocument({ source: png, filename: `${model}_${source.fileUniqueId}.png` }, {
    ...replyTo,
    reply_markup: {
      inline_keyboard: [
        [{ text: ctx.i18n.t('scenes.photoClear.add_to_set_btn'), callback_data: 'add_sticker' }],
        ...modelButtons(ctx, 'clear_retry', { markCurrent: false }).flat()
          .filter((button) => !button.callback_data.endsWith(`:${model}`))
          .map((button) => [{ ...button, text: `↻ ${button.text}` }])
      ]
    }
  })
}

photoClear.on(['photo', 'document'], async (ctx) => {
  const source = resolveSource(ctx.message)

  if (!source) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.not_image'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  return removeBackground(ctx, source, ctx.message.message_id)
})

photoClear.action(/^clear_retry:(\w+)$/, async (ctx) => {
  const source = ctx.session.scene?.clearSource
  if (!source || !MODELS[ctx.match[1]]) return ctx.answerCbQuery()

  ctx.session.scene.clearModel = ctx.match[1]
  await ctx.answerCbQuery()
  return removeBackground(ctx, source, source.replyToMessageId)
})

module.exports = [photoClear]
