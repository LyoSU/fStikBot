const StegCloak = require('stegcloak')
const Composer = require('telegraf/composer')
const { tenor, escapeRegex } = require('../utils')

const stegcloak = new StegCloak(false, false)

const INLINE_QUERY_LIMIT = 50

// ===================
// HELPER FUNCTIONS
// ===================

// All queries below are .lean(), so these read both document shapes directly:
// the flat fields of new docs and the legacy `info.*` sub-document.
const getStickerFileId = (sticker) => sticker.fileId || sticker.info?.file_id

// Trust the stored type, default to 'sticker'. Looking the type up via
// telegram.getFile per result (at ~500M docs, most without a stored type)
// turned inline queries into rate-limit bombs.
const getStickerType = (sticker) => sticker.stickerType || sticker.info?.stickerType || 'sticker'

const getStickerCaption = (sticker) => sticker.caption || sticker.info?.caption

// Stored media type → Telegram's cached inline result type.
// custom_emoji (mosaic cells) and legacy 'text' docs are sticker files.
const INLINE_TYPE = {
  sticker: 'sticker',
  custom_emoji: 'sticker',
  text: 'sticker',
  photo: 'photo',
  video: 'video',
  video_note: 'document',
  document: 'document',
  animation: 'mpeg4_gif',
  gif: 'gif',
  audio: 'audio',
  voice: 'voice'
}

const FILE_ID_FIELD = {
  sticker: 'sticker_file_id',
  photo: 'photo_file_id',
  video: 'video_file_id',
  document: 'document_file_id',
  mpeg4_gif: 'mpeg4_file_id',
  gif: 'gif_file_id',
  audio: 'audio_file_id',
  voice: 'voice_file_id'
}

/**
 * Build an inline result from a stored sticker, or null when its type has no
 * cached-result equivalent. One unknown type used to produce a bogus field
 * like `custom_emoji_file_id`, and Telegram then rejected the WHOLE answer.
 */
function buildInlineResult (sticker) {
  const fileId = getStickerFileId(sticker)
  const type = INLINE_TYPE[getStickerType(sticker)]
  if (!fileId || !type) return null

  const caption = getStickerCaption(sticker)
  const fieldName = FILE_ID_FIELD[type]

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
  const limit = INLINE_QUERY_LIMIT

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

  await ctx.answerInlineQuery(results, {
    is_personal: true,
    cache_time: 30,
    // Only promise another page when this one was full — otherwise the client
    // fires a pointless follow-up query for every short page.
    next_offset: stickerSets.length >= limit ? String(offset + limit) : ''
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

  await ctx.answerInlineQuery(results, {
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
  const limit = INLINE_QUERY_LIMIT

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

    const emptyAnswer = () => ctx.answerInlineQuery([], {
      is_personal: true,
      cache_time: 30,
      switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
      switch_pm_parameter: 'inline_pack'
    }).catch(() => {})

    let searchStickers = []
    let matchedPack = false

    // The queries run with maxTimeMS and throw on timeout. Nothing upstream
    // answers an inline query on error, so without this the user was left on
    // a spinner.
    try {
      let inlineSet = ctx.session.userInfo.inlineStickerSet

      if (!inlineSet) {
        inlineSet = await ctx.db.StickerSet.findOne({
          owner: ctx.session.userInfo.id,
          inline: true
        })
      }

      // Search by query if provided
      if (query.length >= 1) {
        const searchSet = await ctx.db.StickerSet.findOne({
          owner: ctx.session.userInfo.id,
          inline: true,
          $or: [
            { title: { $regex: escapeRegex(query), $options: 'i' } },
            { name: { $regex: escapeRegex(query), $options: 'i' } }
          ]
        }).maxTimeMS(2000)

        if (searchSet) {
          inlineSet = searchSet
          matchedPack = true
        } else {
          // Search across all user's stickers
          const userSetIds = await ctx.db.StickerSet.find({
            owner: ctx.session.userInfo.id,
            hide: false
          }).select('_id').lean()

          searchStickers = await ctx.db.Sticker.find({
            deleted: false,
            stickerSet: { $in: userSetIds.map(s => s._id) },
            $or: [
              { caption: { $regex: escapeRegex(query), $options: 'i' } },
              { emojis: { $regex: escapeRegex(query), $options: 'i' } }
            ]
          })
            .select('_id fileId stickerType caption fileUniqueId emojis info')
            .limit(limit)
            .skip(offset)
            .maxTimeMS(2000)
            .lean()
        }
      }

      // The whole inline pack only for an empty query or a pack-name match: a
      // search that found nothing used to show every sticker ("cat" → dogs).
      if (searchStickers.length === 0 && inlineSet && (query.length === 0 || matchedPack)) {
        searchStickers = await ctx.db.Sticker.find({
          deleted: false,
          stickerSet: inlineSet._id || inlineSet
        })
          .select('_id fileId stickerType caption fileUniqueId emojis info')
          .limit(limit)
          .skip(offset)
          .lean()
      }
    } catch (error) {
      console.error('Inline sticker search failed:', { error: error.message, user: ctx.from.id })
      return emptyAnswer()
    }

    for (const sticker of searchStickers) {
      const result = buildInlineResult(sticker)
      if (result) results.push(result)
    }

    // Send response
    try {
      await ctx.answerInlineQuery(results, {
        is_personal: true,
        cache_time: 30,
        next_offset: searchStickers.length >= limit ? String(offset + limit) : '',
        switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
        switch_pm_parameter: 'inline_pack'
      })
    } catch (error) {
      console.error('Error answering inline query:', {
        error: error.message,
        user: ctx.from.id,
        results_count: results.length
      })

      await emptyAnswer()
    }
  } else {
    // ===================
    // GIF MODE (Tenor)
    // ===================

    let queryText = query
    const match = query.match(/:(.*)/)
    if (match) {
      queryText = match[1]
    }

    // A missing key or a Tenor outage used to throw straight out of the
    // handler: answerInlineQuery was never called and the user stared at a
    // spinner. Always answer — with the "open the bot" button so there's a
    // way forward.
    let tenorResult
    try {
      if (queryText.length >= 1) {
        tenorResult = await tenor.search(queryText, limit, offset)
      } else {
        tenorResult = await tenor.trending(offset || false, ctx.session.userInfo.locale)
      }
    } catch (error) {
      // TENOR_DISABLED (no key, or a 400/401/403 from Tenor) is an expected
      // state, not a bug — log it quietly. Everything else keeps the stack.
      if (error.code === 'TENOR_DISABLED') {
        console.warn('Tenor unavailable:', error.message)
      } else {
        console.error('Tenor request failed:', {
          error: error.message,
          statusCode: error?.response?.statusCode,
          user: ctx.from.id
        })
      }

      return ctx.answerInlineQuery([], {
        is_personal: true,
        cache_time: 30,
        switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
        switch_pm_parameter: 'inline_pack'
      }).catch(() => {})
    }

    nextOffset = tenorResult.next || ''

    for (const item of tenorResult.results || []) {
      const mapped = tenor.mapResult(item)
      if (!mapped) continue

      const result = {
        type: 'mpeg4_gif',
        id: mapped.id,
        // Bot API 6.6 renamed thumb_url → thumbnail_url.
        thumbnail_url: mapped.thumbUrl,
        mpeg4_url: mapped.mp4Url,
        caption: mapped.gifUrl
      }

      // Telegram renders the placeholder at the right aspect ratio when it
      // knows the dimensions up front.
      if (mapped.mp4Width && mapped.mp4Height) {
        result.mpeg4_width = mapped.mp4Width
        result.mpeg4_height = mapped.mp4Height
      }

      results.push(result)
    }

    await ctx.answerInlineQuery(results, {
      is_personal: true,
      cache_time: 30,
      next_offset: results.length > 0 ? String(nextOffset) : '',
      switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
      switch_pm_parameter: 'inline_pack'
    }).catch((error) => {
      console.error('Error answering GIF inline query:', error.message)
    })
  }
})

module.exports = composer
