const StegCloak = require('stegcloak')
const Composer = require('telegraf/composer')
const { tenor } = require('../utils')

const stegcloak = new StegCloak(false, false)

// Cache for file type detection to avoid repeated API calls
const fileTypeCache = new Map()
const FILE_TYPE_CACHE_TTL = 1000 * 60 * 60 // 1 hour

// Cleanup old cache entries every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of fileTypeCache) {
    if (now - value.timestamp > FILE_TYPE_CACHE_TTL) {
      fileTypeCache.delete(key)
    }
  }
}, 1000 * 60 * 10)

// Batch file type detection with caching
async function detectStickerTypes(ctx, stickers) {
  const results = new Map()
  const toFetch = []

  // Check cache first
  for (const sticker of stickers) {
    if (!sticker.info || !sticker.info.file_id) continue

    const cached = fileTypeCache.get(sticker.info.file_id)
    if (cached) {
      results.set(sticker._id.toString(), cached.type)
    } else if (!sticker.info.stickerType) {
      toFetch.push(sticker)
    } else {
      results.set(sticker._id.toString(), sticker.info.stickerType)
    }
  }

  // Batch fetch uncached items (limit concurrency to avoid rate limits)
  if (toFetch.length > 0) {
    const BATCH_SIZE = 10
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE)
      const promises = batch.map(async (sticker) => {
        try {
          const fileInfo = await ctx.tg.getFile(sticker.info.file_id)
          let type = 'sticker'

          if (/document/.test(fileInfo.file_path)) type = 'document'
          else if (/photo/.test(fileInfo.file_path)) type = 'photo'

          // Cache the result
          fileTypeCache.set(sticker.info.file_id, { type, timestamp: Date.now() })

          // Update sticker in DB (fire and forget)
          sticker.info.stickerType = type
          sticker.save().catch(() => {})

          return { id: sticker._id.toString(), type }
        } catch {
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

const composer = new Composer()

composer.on('inline_query', async (ctx, next) => {
  const offset = parseInt(ctx.inlineQuery.offset) || 0
  const limit = 50
  const query = ctx.inlineQuery.query

  if (!query || !query.includes('select_group_pack')) {
    return next()
  }

  const stickerSets = await ctx.db.StickerSet.find({
    owner: ctx.session.userInfo.id,
    inline: false,
    hide: false
  }).select('_id title name').sort({ updatedAt: -1 }).limit(limit).skip(offset).lean()

  if (!stickerSets || stickerSets.length <= 0) {
    return ctx.answerInlineQuery([], {
      is_personal: true,
      cache_time: 30,
      next_offset: offset + limit,
      switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
      switch_pm_parameter: 'pack'
    })
  }

  const results = stickerSets.map((stickerSet) => {
    return {
      type: 'article',
      id: stickerSet._id.toString(),
      title: stickerSet.title,
      description: stickerSet.name,
      input_message_content: {
        message_text: `/pack ${stickerSet.name}`,
        parse_mode: 'HTML'
      }
    }
  })

  ctx.answerInlineQuery(results, {
    is_personal: true,
    cache_time: 30,
    next_offset: offset + limit
  })
})

composer.on('inline_query', async (ctx, next) => {
  const query = ctx.inlineQuery.query

  if (!query || !query.includes('group_settings')) {
    return next()
  }

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

composer.on('inline_query', async (ctx) => {
  const offset = parseInt(ctx.inlineQuery.offset) || 0
  const limit = 50
  const query = ctx.inlineQuery.query

  let nextOffset = offset + limit

  const stickersResult = []

  let data

  try {
    data = stegcloak.reveal(`: ${query}`, '')
  } catch (e) {
    // do nothing
  }

  if (ctx.session.userInfo.inlineType === 'packs' && data !== '{gif}') {
    let inlineSet = ctx.session.userInfo.inlineStickerSet

    if (!inlineSet) {
      inlineSet = await ctx.db.StickerSet.findOne({
        owner: ctx.session.userInfo.id,
        inline: true
      })
    }

    let searchStickers = []

    if (query.length >= 1) {
      const search = await ctx.db.StickerSet.findOne({
        owner: ctx.session.userInfo.id,
        inline: true,
        $text: { $search: query }
      }).maxTimeMS(2000)

      if (search) inlineSet = search
      else {
        // Only fetch _id for filtering, not full documents
        const userStickerSetIds = await ctx.db.StickerSet.find({
          owner: ctx.session.userInfo.id,
          hide: false
        }).select('_id').lean()

        searchStickers = await ctx.db.Sticker.find({
          deleted: false,
          stickerSet: { $in: userStickerSetIds.map(s => s._id) },
          $text: { $search: query }
        }).select('_id info emojis fileUniqueId').limit(limit).skip(offset).maxTimeMS(2000).lean()
      }
    }

    if (searchStickers.length <= 0) {
      searchStickers = await ctx.db.Sticker.find({
        deleted: false,
        stickerSet: inlineSet
      }).select('_id info emojis fileUniqueId').limit(limit).skip(offset).lean()
    }

    // Pre-fetch all sticker types in parallel (optimized)
    const stickerTypes = await detectStickerTypes(ctx, searchStickers)

    for (const sticker of searchStickers) {
      try {
        if (!sticker.info || !sticker.info.file_id) continue

        let stickerType = stickerTypes.get(sticker._id.toString()) || sticker.info.stickerType || 'sticker'

        if (stickerType === 'video_note') stickerType = 'document'
        if (stickerType === 'animation') stickerType = 'mpeg4_gif'

        let fieldFileIdName = stickerType + '_file_id'
        if (stickerType === 'mpeg4_gif') fieldFileIdName = 'mpeg4_file_id'
        if (stickerType === 'gif') fieldFileIdName = 'gif_file_id'

        const data = {
          type: stickerType,
          id: sticker._id.toString()
        }
        data[fieldFileIdName] = sticker.info.file_id

        if (stickerType === 'document' || stickerType === 'video') {
          data.title = sticker.info.caption || 'File'
          data.description = sticker.info.caption || ''
        } else if (stickerType === 'photo' || stickerType === 'mpeg4_gif' || stickerType === 'gif') {
          if (sticker.info.caption) {
            data.title = sticker.info.caption
            data.description = sticker.info.caption
          }
        }

        stickersResult.push(data)
      } catch (error) {
        console.error('Error processing sticker for inline query:', {
          sticker_id: sticker._id,
          error: error.message
        })
      }
    }

    try {
      await ctx.answerInlineQuery(stickersResult, {
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
        pack: inlineSet ? inlineSet.name : 'unknown',
        results_count: stickersResult.length
      })
      // Якщо помилка - повертаємо порожній результат
      await ctx.answerInlineQuery([], {
        is_personal: true,
        cache_time: 30,
        switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
        switch_pm_parameter: 'inline_pack'
      }).catch(() => {})
    }
  } else {
    let tenorResult

    let queryText = query

    try {
      queryText = query.match(/:(.*)/)[1]
    } catch (error) {
    }

    if (queryText.length >= 1) {
      tenorResult = await tenor.search(queryText, limit, offset)

      nextOffset = tenorResult.next
    } else {
      tenorResult = await tenor.trending(offset || false, ctx.session.userInfo.locale)

      nextOffset = tenorResult.next
    }

    for (const item of tenorResult.results) {
      const thumb = item.media[0].gif.url
      const gif = item.media[0].mp4.url
      const caption = item.media[0].gif_transparent.url
      const id = item.id

      stickersResult.push({
        type: 'mpeg4_gif',
        id,
        thumb_url: thumb,
        mpeg4_url: gif,
        caption
      })
    }

    await ctx.answerInlineQuery(stickersResult, {
      is_personal: true,
      cache_time: 30,
      next_offset: nextOffset
    })
  }
})

module.exports = composer
