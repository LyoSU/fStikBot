const StegCloak = require('stegcloak')
const Composer = require('telegraf/composer')
const { tenor } = require('../utils')

const stegcloak = new StegCloak(false, false)

// ===================
// CACHE CONFIGURATION
// ===================

const fileTypeCache = new Map()
const FILE_TYPE_CACHE_TTL = 1000 * 60 * 60 // 1 hour

// Cleanup old cache entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of fileTypeCache) {
    if (now - value.timestamp > FILE_TYPE_CACHE_TTL) {
      fileTypeCache.delete(key)
    }
  }
}, 1000 * 60 * 10)

// ===================
// HELPER FUNCTIONS
// ===================

/**
 * Get file ID from sticker (supports both old and new schema)
 * Works with both Mongoose documents and lean objects
 */
function getStickerFileId (sticker) {
  if (typeof sticker.getFileId === 'function') {
    return sticker.getFileId()
  }
  return sticker.fileId || (sticker.info && sticker.info.file_id)
}

/**
 * Get sticker type (supports both old and new schema)
 */
function getStickerType (sticker) {
  if (typeof sticker.getStickerType === 'function') {
    return sticker.getStickerType()
  }
  return sticker.stickerType || (sticker.info && sticker.info.stickerType) || 'sticker'
}

/**
 * Get caption (supports both old and new schema)
 */
function getStickerCaption (sticker) {
  if (typeof sticker.getCaption === 'function') {
    return sticker.getCaption()
  }
  return sticker.caption || (sticker.info && sticker.info.caption)
}

/**
 * Batch detect sticker types with caching
 * Minimizes Telegram API calls by caching results
 */
async function detectStickerTypes (ctx, stickers) {
  const results = new Map()
  const toFetch = []

  for (const sticker of stickers) {
    const fileId = getStickerFileId(sticker)
    if (!fileId) continue

    const cached = fileTypeCache.get(fileId)
    if (cached) {
      results.set(sticker._id.toString(), cached.type)
    } else {
      const existingType = getStickerType(sticker)
      if (existingType && existingType !== 'sticker') {
        results.set(sticker._id.toString(), existingType)
      } else {
        toFetch.push(sticker)
      }
    }
  }

  // Batch fetch uncached items with concurrency limit
  if (toFetch.length > 0) {
    const BATCH_SIZE = 10

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE)

      const promises = batch.map(async (sticker) => {
        const fileId = getStickerFileId(sticker)
        try {
          const fileInfo = await ctx.tg.getFile(fileId)
          let type = 'sticker'

          if (/document/.test(fileInfo.file_path)) type = 'document'
          else if (/photo/.test(fileInfo.file_path)) type = 'photo'

          // Cache the result
          fileTypeCache.set(fileId, { type, timestamp: Date.now() })

          // Update sticker in DB (fire and forget for performance)
          ctx.db.Sticker.updateOne(
            { _id: sticker._id },
            { $set: { stickerType: type } }
          ).catch(() => {})

          return { id: sticker._id.toString(), type }
        } catch (err) {
          return { id: sticker._id.toString(), type: 'sticker' }
        }
      })

      const batchResults = await Promise.all(promises)
      for (const { id, type } of batchResults) {
        results.set(id, type)
      }
    }
  }

  return results
}

/**
 * Build inline query result item from sticker
 */
function buildInlineResult (sticker, stickerType) {
  const fileId = getStickerFileId(sticker)
  const caption = getStickerCaption(sticker)

  // Normalize type for Telegram API
  let type = stickerType
  if (type === 'video_note') type = 'document'
  if (type === 'animation') type = 'mpeg4_gif'

  // Map type to correct file_id field name
  const fileIdFieldMap = {
    mpeg4_gif: 'mpeg4_file_id',
    gif: 'gif_file_id'
  }
  const fieldName = fileIdFieldMap[type] || type + '_file_id'

  const result = {
    type,
    id: sticker._id.toString(),
    [fieldName]: fileId
  }

  // Add metadata for documents and media
  if (type === 'document' || type === 'video') {
    result.title = caption || 'File'
    result.description = caption || ''
  } else if (['photo', 'mpeg4_gif', 'gif'].includes(type) && caption) {
    result.title = caption
    result.description = caption
  }

  return result
}

// ===================
// INLINE QUERY HANDLERS
// ===================

const composer = new Composer()

/**
 * Handle pack selection inline query
 */
composer.on('inline_query', async (ctx, next) => {
  const { query, offset: rawOffset } = ctx.inlineQuery
  if (!query || !query.includes('select_group_pack')) return next()

  const offset = parseInt(rawOffset) || 0
  const limit = 50

  const stickerSets = await ctx.db.StickerSet.find({
    owner: ctx.session.userInfo.id,
    inline: false,
    hide: false
  })
    .select('_id title name')
    .sort({ updatedAt: -1 })
    .limit(limit)
    .skip(offset)
    .lean()

  if (!stickerSets || stickerSets.length === 0) {
    return ctx.answerInlineQuery([], {
      is_personal: true,
      cache_time: 30,
      next_offset: offset + limit,
      switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
      switch_pm_parameter: 'pack'
    })
  }

  const results = stickerSets.map((set) => ({
    type: 'article',
    id: set._id.toString(),
    title: set.title,
    description: set.name,
    input_message_content: {
      message_text: `/pack ${set.name}`,
      parse_mode: 'HTML'
    }
  }))

  ctx.answerInlineQuery(results, {
    is_personal: true,
    cache_time: 30,
    next_offset: offset + limit
  })
})

/**
 * Handle group settings inline query
 */
composer.on('inline_query', async (ctx, next) => {
  const { query } = ctx.inlineQuery
  if (!query || !query.includes('group_settings')) return next()

  const type = query.split(' ')[1]

  const results = [
    {
      type: 'article',
      id: 'everyone',
      title: ctx.i18n.t('callback.pack.select_group.access_rights.rights.all'),
      input_message_content: {
        message_text: `/group_settings ${type} all`,
        parse_mode: 'HTML'
      }
    },
    {
      type: 'article',
      id: 'admins',
      title: ctx.i18n.t('callback.pack.select_group.access_rights.rights.admins'),
      input_message_content: {
        message_text: `/group_settings ${type} admins`,
        parse_mode: 'HTML'
      }
    }
  ]

  ctx.answerInlineQuery(results, {
    is_personal: true,
    cache_time: 30
  })
})

/**
 * Main sticker/GIF inline query handler
 */
composer.on('inline_query', async (ctx) => {
  const { query, offset: rawOffset } = ctx.inlineQuery
  const offset = parseInt(rawOffset) || 0
  const limit = 50

  let nextOffset = offset + limit
  const results = []

  // Try to decode hidden data in query
  let hiddenData
  try {
    hiddenData = stegcloak.reveal(`: ${query}`, '')
  } catch (err) {
    // No hidden data
  }

  const isGifMode = ctx.session.userInfo.inlineType !== 'packs' || hiddenData === '{gif}'

  if (!isGifMode) {
    // ===================
    // STICKER PACK MODE
    // ===================

    let inlineSet = ctx.session.userInfo.inlineStickerSet

    if (!inlineSet) {
      inlineSet = await ctx.db.StickerSet.findOne({
        owner: ctx.session.userInfo.id,
        inline: true
      })
    }

    let searchStickers = []

    // Search by query if provided
    if (query.length >= 1) {
      const searchSet = await ctx.db.StickerSet.findOne({
        owner: ctx.session.userInfo.id,
        inline: true,
        $text: { $search: query }
      }).maxTimeMS(2000)

      if (searchSet) {
        inlineSet = searchSet
      } else {
        // Search across all user's stickers
        const userSetIds = await ctx.db.StickerSet.find({
          owner: ctx.session.userInfo.id,
          hide: false
        }).select('_id').lean()

        searchStickers = await ctx.db.Sticker.find({
          deleted: false,
          stickerSet: { $in: userSetIds.map(s => s._id) },
          $text: { $search: query }
        })
          .select('_id fileId stickerType caption fileUniqueId emojis info')
          .limit(limit)
          .skip(offset)
          .maxTimeMS(2000)
          .lean()
      }
    }

    // Fallback to inline set stickers
    if (searchStickers.length === 0 && inlineSet) {
      searchStickers = await ctx.db.Sticker.find({
        deleted: false,
        stickerSet: inlineSet._id || inlineSet
      })
        .select('_id fileId stickerType caption fileUniqueId emojis info')
        .limit(limit)
        .skip(offset)
        .lean()
    }

    // Batch detect sticker types
    const stickerTypes = await detectStickerTypes(ctx, searchStickers)

    // Build results
    for (const sticker of searchStickers) {
      try {
        const fileId = getStickerFileId(sticker)
        if (!fileId) continue

        const type = stickerTypes.get(sticker._id.toString()) || getStickerType(sticker)
        results.push(buildInlineResult(sticker, type))
      } catch (error) {
        console.error('Error processing sticker:', {
          sticker_id: sticker._id,
          error: error.message
        })
      }
    }

    // Send response
    try {
      await ctx.answerInlineQuery(results, {
        is_personal: true,
        cache_time: 30,
        next_offset: offset + limit,
        switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
        switch_pm_parameter: 'inline_pack'
      })
    } catch (error) {
      console.error('Error answering inline query:', {
        error: error.message,
        user: ctx.from.id,
        results_count: results.length
      })

      // Fallback to empty response
      await ctx.answerInlineQuery([], {
        is_personal: true,
        cache_time: 30,
        switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
        switch_pm_parameter: 'inline_pack'
      }).catch(() => {})
    }
  } else {
    // ===================
    // GIF MODE (Tenor)
    // ===================

    let queryText = query
    try {
      queryText = query.match(/:(.*)/)[1]
    } catch (err) {
      // Use original query
    }

    let tenorResult
    if (queryText.length >= 1) {
      tenorResult = await tenor.search(queryText, limit, offset)
    } else {
      tenorResult = await tenor.trending(offset || false, ctx.session.userInfo.locale)
    }

    nextOffset = tenorResult.next

    for (const item of tenorResult.results) {
      results.push({
        type: 'mpeg4_gif',
        id: item.id,
        thumb_url: item.media[0].gif.url,
        mpeg4_url: item.media[0].mp4.url,
        caption: item.media[0].gif_transparent.url
      })
    }

    await ctx.answerInlineQuery(results, {
      is_personal: true,
      cache_time: 30,
      next_offset: nextOffset
    })
  }
})

module.exports = composer
