const StegCloak = require('stegcloak')
const Composer = require('telegraf/composer')
const { tenor } = require('../utils')

const stegcloak = new StegCloak(false, false)

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
  }).sort({ updatedAt: -1 }).limit(limit).skip(offset)

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
        const userStickerSet = await ctx.db.StickerSet.find({
          owner: ctx.session.userInfo.id,
          hide: false
        })

        searchStickers = await ctx.db.Sticker.find({
          deleted: false,
          stickerSet: { $in: userStickerSet },
          $text: { $search: query }
        }).limit(limit).skip(offset).maxTimeMS(2000)
      }
    }

    if (searchStickers.length <= 0) {
      searchStickers = await ctx.db.Sticker.find({
        deleted: false,
        stickerSet: inlineSet
      }).limit(limit).skip(offset)
    }

    for (const sticker of searchStickers) {
      try {
        // Пропускаємо стікери без file_id
        if (!sticker.info || !sticker.info.file_id) continue

        if (!sticker.info.stickerType) {
          const fileInfo = await ctx.tg.getFile(sticker.info.file_id)
          if (/document/.test(fileInfo.file_path)) sticker.info.stickerType = 'document'
          else if (/photo/.test(fileInfo.file_path)) sticker.info.stickerType = 'photo'
          else sticker.info.stickerType = 'sticker'
          await sticker.save()
        }

        if (sticker.info.stickerType === 'video_note') {
          sticker.info.stickerType = 'document'
        }

        if (sticker.info.stickerType === 'animation') sticker.info.stickerType = 'mpeg4_gif'

        let stickerType = sticker.info.stickerType

        // Перевіряємо файл тільки для типу 'sticker'
        if (stickerType === 'sticker') {
          const fileInfo = await ctx.tg.getFile(sticker.info.file_id)

          // Фільтруємо тільки анімовані .tgs стікери
          if (/\.tgs$/i.test(fileInfo.file_path)) {
            continue
          }

          // Визначаємо тип по розширенню файлу
          if (fileInfo.file_path.includes('animations/')) {
            // .mp4 → mpeg4_gif, .gif → gif
            if (/\.mp4$/i.test(fileInfo.file_path)) {
              stickerType = 'mpeg4_gif'
            } else if (/\.gif$/i.test(fileInfo.file_path)) {
              stickerType = 'gif'
            }
          }
          // Конвертуємо videos/ в video
          else if (fileInfo.file_path.includes('videos/')) {
            stickerType = 'video'
          }
        }

        let fieldFileIdName = stickerType + '_file_id'
        if (stickerType === 'mpeg4_gif') fieldFileIdName = 'mpeg4_file_id'
        if (stickerType === 'gif') fieldFileIdName = 'gif_file_id'

        const data = {
          type: stickerType,
          id: sticker._id.toString()
        }
        data[fieldFileIdName] = sticker.info.file_id

        // Різні типи мають різні обов'язкові поля
        if (stickerType === 'document' || stickerType === 'video') {
          // title обов'язкове для document і video
          data.title = sticker.info.caption || 'File'
          data.description = sticker.info.caption || ''
        } else if (stickerType === 'photo' || stickerType === 'mpeg4_gif' || stickerType === 'gif') {
          // title опціональне для photo, mpeg4_gif та gif
          if (sticker.info.caption) {
            data.title = sticker.info.caption
            data.description = sticker.info.caption
          }
        }
        // sticker не має поля title взагалі

        stickersResult.push(data)
      } catch (error) {
        // Пропускаємо проблемний стікер, але продовжуємо обробку інших
        console.error('Error processing sticker for inline query:', {
          sticker_id: sticker._id,
          type: sticker.info && sticker.info.stickerType,
          file_id: sticker.info && sticker.info.file_id,
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
        results_count: stickersResult.length,
        first_result_full: stickersResult.length > 0 ? stickersResult[0] : null
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
