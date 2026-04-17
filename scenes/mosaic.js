const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const { getGridSuggestions } = require('../utils/mosaic-grid')
const { generatePreview } = require('../utils/mosaic-preview')
const { splitImage, checkMinCellSize } = require('../utils/mosaic-split')
const { getRateLimitRemaining } = require('../utils/retry-api')
const https = require('https')
const sharp = require('sharp')

const { match } = I18n

const mosaic = new Scene('mosaic')

// Download file from Telegram URL
const downloadFile = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  const MAX_SIZE = 20 * 1024 * 1024
  const req = https.get(fileUrl, (response) => {
    if (response.statusCode !== 200) { req.destroy(); reject(new Error(`Download failed: ${response.statusCode}`)); return }
    response.on('data', (chunk) => {
      totalSize += chunk.length
      if (totalSize > MAX_SIZE) { req.destroy(); reject(new Error('File too large')); return }
      data.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(data)))
  })
  req.on('error', reject)
  req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')) })
})

const FALLBACK_EMOJI = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜', '🔲']

// Helper: build inline keyboard for grid selection
const buildGridKeyboard = (ctx, suggestions) => {
  const { recommended, alternatives } = suggestions
  const buttons = []

  // Row 1: recommended
  buttons.push([
    Markup.callbackButton(
      ctx.i18n.t('cmd.mosaic.btn.recommended', { rows: recommended.rows, cols: recommended.cols }),
      `mosaic:grid:${recommended.rows}:${recommended.cols}`
    )
  ])

  // Row 2: alternatives
  if (alternatives.length > 0) {
    buttons.push(alternatives.map(alt =>
      Markup.callbackButton(
        ctx.i18n.t('cmd.mosaic.btn.option', { rows: alt.rows, cols: alt.cols, total: alt.total }),
        `mosaic:grid:${alt.rows}:${alt.cols}`
      )
    ))
  }

  // Row 3: custom + cancel
  buttons.push([
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.custom'), 'mosaic:custom'),
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.cancel'), 'mosaic:cancel')
  ])

  // Row 4: exit
  buttons.push([
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.exit'), 'mosaic:exit')
  ])

  return Markup.inlineKeyboard(buttons)
}

// --- Enter handler ---

mosaic.enter(async (ctx) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  ctx.session.scene.mosaic = {}

  // Check if user has a custom_emoji pack selected
  const userInfo = ctx.session.userInfo
  if (!userInfo || !userInfo.stickerSet) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_pack'))
    return ctx.scene.leave()
  }

  const stickerSet = await ctx.db.StickerSet.findById(userInfo.stickerSet)
  if (!stickerSet || stickerSet.packType !== 'custom_emoji') {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_pack'))
    return ctx.scene.leave()
  }

  ctx.session.scene.mosaic.packId = stickerSet.id
  ctx.session.scene.mosaic.packName = stickerSet.name

  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.enter', {
    packTitle: stickerSet.title
  }), {
    reply_markup: Markup.keyboard([
      [{ text: ctx.i18n.t('cmd.mosaic.btn.exit') }]
    ]).resize()
  })
})

// Normalize any accepted message into { fileId, width, height } or { error: <i18n-key> }.
// For documents, width/height come from the optional thumb — may be null, caller reads from buffer.
const IMAGE_DOCUMENT_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const getMosaicSource = (message) => {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]
    return { fileId: largest.file_id, width: largest.width, height: largest.height }
  }

  if (message.sticker) {
    if (message.sticker.is_animated || message.sticker.is_video) {
      return { error: 'cmd.mosaic.reject_animated' }
    }
    return {
      fileId: message.sticker.file_id,
      width: message.sticker.width,
      height: message.sticker.height
    }
  }

  if (message.document) {
    const mime = message.document.mime_type
    if (!mime || !IMAGE_DOCUMENT_MIMES.has(mime)) {
      return { error: 'cmd.mosaic.reject_document' }
    }
    return {
      fileId: message.document.file_id,
      width: message.document.thumb ? message.document.thumb.width : null,
      height: message.document.thumb ? message.document.thumb.height : null
    }
  }

  // Should not be reachable — handler only binds to photo/document/sticker.
  return { error: 'cmd.mosaic.reject_media' }
}

// --- Photo handler ---

mosaic.on(['photo', 'document', 'sticker'], async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  // Block new input while uploading
  if (ctx.session.scene.mosaic.uploading) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.uploading', { current: '...', total: '...' }))
  }

  const source = getMosaicSource(ctx.message)
  if (source.error) {
    return ctx.replyWithHTML(ctx.i18n.t(source.error))
  }

  // Download + decode + preview. Wrap in try/catch so the user gets a
  // specific "download/decode failed" message instead of the generic
  // bot.catch "unknown error" fallback when a Telegram file times out
  // or sharp fails to parse the input.
  let imageBuffer, width, height, previewBuffer, suggestions
  let stickerSet, freeSlots
  try {
    const fileUrl = await ctx.telegram.getFileLink(source.fileId)
    imageBuffer = await downloadFile(fileUrl.href || fileUrl)

    // Documents don't carry width/height on the message itself — read from buffer.
    ;({ width, height } = source)
    if (!width || !height) {
      const meta = await sharp(imageBuffer).metadata()
      width = meta.width
      height = meta.height
    }

    stickerSet = await ctx.db.StickerSet.findById(ctx.session.scene.mosaic.packId)
    const currentCount = await ctx.db.Sticker.countDocuments({
      stickerSet: stickerSet.id,
      deleted: false
    })
    freeSlots = 200 - currentCount

    suggestions = getGridSuggestions(width, height, freeSlots)

    if (suggestions.type === 'no_space') {
      await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_space', { freeSlots, total: 4 }))
      return
    }

    previewBuffer = await generatePreview(imageBuffer, suggestions.recommended.rows, suggestions.recommended.cols)
  } catch (err) {
    console.error('[mosaic] preview prep failed:', err.message)
    const key = /Too large|Timeout|Download/.test(err.message)
      ? 'sticker.add.error.convert'
      : 'sticker.add.error.invalid_image'
    return ctx.replyWithHTML(ctx.i18n.t(key))
  }

  // Store in scene state
  ctx.session.scene.mosaic.photoFileId = source.fileId
  ctx.session.scene.mosaic.photoWidth = width
  ctx.session.scene.mosaic.photoHeight = height
  ctx.session.scene.mosaic.freeSlots = freeSlots

  const { recommended } = suggestions

  // Check for blurry warning
  const isBlurry = !checkMinCellSize(width, height, recommended.rows, recommended.cols)
  const blurryText = isBlurry ? '\n' + ctx.i18n.t('cmd.mosaic.blurry_warning') : ''

  const msg = await ctx.replyWithPhoto(
    { source: previewBuffer },
    {
      caption: ctx.i18n.t('cmd.mosaic.choose_grid') + blurryText,
      parse_mode: 'HTML',
      reply_markup: buildGridKeyboard(ctx, suggestions)
    }
  )

  ctx.session.scene.mosaic.previewMessageId = msg.message_id
})

// --- Reject animated/video inputs ---

mosaic.on(['animation', 'video', 'video_note'], async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  if (ctx.session.scene.mosaic.uploading) return
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.reject_media'))
})

// --- Shared processMosaic function ---

const processMosaic = async (ctx, rows, cols) => {
  const state = ctx.session.scene.mosaic
  const total = rows * cols

  // Lock: prevent concurrent processing
  if (state.uploading) {
    return
  }

  if (!state.photoFileId) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
    return
  }

  // Pre-check: if the user's addStickerToSet is in a 429 cooldown we'd
  // get synthetic 429 on every single cell. Better to bail here with a
  // clear "wait N seconds" than half-upload and roll back.
  const cooldown = getRateLimitRemaining('addStickerToSet', ctx.from.id)
  if (cooldown > 0) {
    await ctx.replyWithHTML(ctx.i18n.t('error.rate_limit_seconds', { seconds: cooldown }))
    return
  }

  state.uploading = true

  try {
    // Download photo again (not stored in session)
    const fileUrl = await ctx.telegram.getFileLink(state.photoFileId)
    const imageBuffer = await downloadFile(fileUrl.href || fileUrl)

    // Send progress message
    const progressMsg = await ctx.replyWithHTML(
      ctx.i18n.t('cmd.mosaic.uploading', { current: 0, total })
    )

    // Split image
    const cells = await splitImage(imageBuffer, rows, cols)

    // Upload all cells to the pack
    const stickerSet = await ctx.db.StickerSet.findById(state.packId)
    const uploadedIds = []
    const uploadedFileIds = []
    let uploadedCount = 0

    for (let i = 0; i < cells.length; i++) {
      const r = Math.floor(i / cols) + 1
      const c = (i % cols) + 1
      const fallbackEmoji = FALLBACK_EMOJI[i % FALLBACK_EMOJI.length]

      try {
        // No outer retry: ctx.telegram.callApi is already wrapped by
        // utils/retry-api (auto-retries 429 with retry_after ≤ 5s, caches
        // method+user cooldowns). A second exponential-backoff layer here
        // just re-tried synthetic 429s 25× and burned ~3min of waits per
        // partial-failed mosaic.
        const uploaded = await ctx.telegram.callApi('uploadStickerFile', {
          user_id: ctx.from.id,
          sticker_format: 'static',
          sticker: { source: cells[i] }
        })

        await ctx.telegram.callApi('addStickerToSet', {
          user_id: ctx.from.id,
          name: stickerSet.name,
          sticker: {
            sticker: uploaded.file_id,
            format: 'static',
            emoji_list: [fallbackEmoji],
            keywords: ['mosaic', `r${r}c${c}`]
          }
        })
        uploadedCount++
      } catch (err) {
        // Upload failed — rollback what succeeded via getStickerSet.
        if (uploadedCount > 0) {
          const partialSet = await ctx.telegram.callApi('getStickerSet', { name: stickerSet.name }).catch(() => null)
          if (partialSet) {
            const toRollback = partialSet.stickers.slice(-uploadedCount)
            for (const s of toRollback) {
              await ctx.telegram.callApi('deleteStickerFromSet', { sticker: s.file_id }).catch(() => {})
            }
          }
        }
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {})

        // Pick a message that actually tells the user WHY it failed,
        // instead of the generic "undo_failed" for every kind of error.
        const description = err?.description || err?.message || ''
        let replyKey = 'cmd.mosaic.undo_failed'
        if (err?.code === 429) {
          const retryAfter = err?.parameters?.retry_after || getRateLimitRemaining('addStickerToSet', ctx.from.id)
          await ctx.replyWithHTML(ctx.i18n.t('error.rate_limit_seconds', { seconds: retryAfter || 30 }))
          return
        } else if (description.includes('STICKERSET_INVALID')) {
          replyKey = 'sticker.add.error.stickerset_invalid'
        } else if (description.includes('TOO_MUCH')) {
          replyKey = 'sticker.add.error.stickers_too_much'
        }
        await ctx.replyWithHTML(ctx.i18n.t(replyKey))
        return
      }

      // Update progress every 3 uploads
      if ((i + 1) % 3 === 0 || i === cells.length - 1) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, progressMsg.message_id, null,
          ctx.i18n.t('cmd.mosaic.uploading', { current: i + 1, total })
        ).catch(() => {})
        await ctx.telegram.callApi('sendChatAction', {
          chat_id: ctx.chat.id, action: 'choose_sticker'
        }).catch(() => {})
      }
    }

    // Get all sticker IDs in one API call (instead of N calls during upload)
    const setInfo = await ctx.telegram.callApi('getStickerSet', { name: stickerSet.name })
    const addedStickers = setInfo.stickers.slice(-total)
    for (const sticker of addedStickers) {
      uploadedIds.push(sticker.custom_emoji_id)
      uploadedFileIds.push(sticker.file_id)
      await ctx.db.Sticker.addSticker(stickerSet.id, '🔲', {
        file_id: sticker.file_id,
        file_unique_id: sticker.file_unique_id,
        stickerType: 'custom_emoji'
      })
    }

    // Delete progress message
    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {})

    // Build mosaic message with custom_emoji entities
    const placeholder = '\u2B1C'
    let text = ''
    const entities = []

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c
        const offset = text.length
        text += placeholder
        entities.push({
          type: 'custom_emoji',
          offset,
          length: placeholder.length,
          custom_emoji_id: uploadedIds[idx]
        })
      }
      if (r < rows - 1) text += '\n'
    }

    // Send mosaic as pure-emoji message (no text!) for correct Telegram rendering
    await ctx.telegram.callApi('sendMessage', {
      chat_id: ctx.chat.id,
      text,
      entities
    })

    // Send pack link + undo as separate message
    const packLink = `${ctx.config.emojiLinkPrefix}${stickerSet.name}`
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.done', { rows, cols }), {
      reply_markup: Markup.inlineKeyboard([
        [Markup.urlButton(ctx.i18n.t('cmd.mosaic.done_link'), packLink)],
        [Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.undo'), 'mosaic:undo')]
      ])
    })

    // Store uploaded file IDs for undo
    state.lastMosaicIds = uploadedFileIds
    state.lastMosaicCount = total
    state.waitingCustom = false

    // Ready for next photo
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
  } finally {
    state.uploading = false
  }
}

// --- Action handlers ---

// Grid selection callback
mosaic.action(/^mosaic:grid:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  const rows = parseInt(ctx.match[1])
  const cols = parseInt(ctx.match[2])
  const total = rows * cols
  const state = ctx.session.scene.mosaic

  if (!state.photoFileId || rows < 1 || rows > 10 || cols < 1 || cols > 10 || total < 2 || total > 50) {
    return ctx.answerCbQuery(ctx.i18n.t('cmd.mosaic.custom_invalid'), true)
  }

  if (total > state.freeSlots) {
    return ctx.answerCbQuery(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }), true)
  }

  await ctx.answerCbQuery()
  return processMosaic(ctx, rows, cols)
})

// Custom size: prompt
mosaic.action('mosaic:custom', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()
  ctx.session.scene.mosaic.waitingCustom = true
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_prompt'))
})

// Cancel current photo
mosaic.action('mosaic:cancel', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()
  ctx.session.scene.mosaic.photoFileId = null
  ctx.session.scene.mosaic.waitingCustom = false
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
})

// Undo: remove last mosaic from pack
mosaic.action('mosaic:undo', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  const state = ctx.session.scene.mosaic
  if (!state.lastMosaicIds || state.lastMosaicIds.length === 0) {
    return ctx.answerCbQuery()
  }

  await ctx.answerCbQuery()

  let deleted = 0
  for (const fileId of state.lastMosaicIds) {
    try {
      await ctx.telegram.callApi('deleteStickerFromSet', { sticker: fileId })
      await ctx.db.Sticker.updateOne(
        { fileId, stickerSet: state.packId },
        { $set: { deleted: true, deletedAt: new Date() } }
      )
      deleted++
    } catch (e) {
      // Sticker may already be deleted
    }
  }

  state.lastMosaicIds = []

  if (deleted > 0) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.undo_done', { count: deleted }))
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.undo_failed'))
  }
})

// Exit scene
mosaic.action('mosaic:exit', async (ctx) => {
  await ctx.answerCbQuery()
  delete ctx.session.scene.mosaic
  await ctx.scene.leave()
})

// --- Text handler for custom size ---

mosaic.on('text', async (ctx) => {
  if (!ctx.session.scene?.mosaic?.waitingCustom) return

  const text = ctx.message.text.trim()

  // Flexible parsing: 3x4, 3×4, 3*4, 3:4, 3 на 4, 3 by 4, 3 on 4
  const match = text.match(/^(\d+)\s*[x×*:]\s*(\d+)$/i) ||
                text.match(/^(\d+)\s+(?:на|by|on)\s+(\d+)$/i)

  if (!match) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const rows = parseInt(match[1])
  const cols = parseInt(match[2])
  const total = rows * cols

  if (rows < 1 || rows > 10 || cols < 1 || cols > 10 || total < 2 || total > 50) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const state = ctx.session.scene.mosaic
  if (total > state.freeSlots) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }))
  }

  return processMosaic(ctx, rows, cols)
})

// --- Exit via keyboard button ---

mosaic.hears(match('cmd.mosaic.btn.exit'), async (ctx) => {
  delete ctx.session.scene.mosaic
  await ctx.scene.leave()
})

module.exports = mosaic
