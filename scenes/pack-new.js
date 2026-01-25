const got = require('got')
const slug = require('limax')
const StegCloak = require('stegcloak')
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const { uniqueNamesGenerator, adjectives, colors, animals } = require('unique-names-generator');

const {
  escapeHTML,
  addSticker,
  countUncodeChars,
  substrUnicode,
} = require('../utils')

const { match } = I18n

const placeholder = {
  regular: {
    video: 'sticker_placeholder.webm',
    animated: 'sticker_placeholder.tgs',
    static: 'sticker_placeholder.webp'
  },
  custom_emoji: {
    video: 'emoji_placeholder.webm',
    animated: 'sticker_placeholder.tgs',
    static: 'emoji_placeholder.webp'
  }
}

const animalEmojis = {
  Dog: "🐶",
  Cat: "🐱",
  Fox: "🦊",
  Bear: "🐻",
  Koala: "🐨",
  Tiger: "🐯",
  Lion: "🦁",
  Cow: "🐮",
  Pig: "🐷",
  Frog: "🐸",
  Octopus: "🐙",
  Turtle: "🐢",
  Squid: "🦑",
  Dolphin: "🐬",
  Whale: "🐋",
  Bunny: "🐰",
  Unicorn: "🦄",
  Dragon: "🐉",
  Lizard: "🦎",
  Penguin: "🐧",
  Bat: "🦇",
  Shark: "🦈",
  Owl: "🦉",
  Bee: "🐝",
  Ladybug: "🐞",
  Butterfly: "🦋",
  Ant: "🐜",
  Mosquito: "🦟",
  Spider: "🕷",
  Scorpion: "🦂",
  Crab: "🦀",
  Snail: "🐌",
  Worm: "🪱",
  Mouse: "🐭",
  Rat: "🐀",
  Hamster: "🐹",
  Chipmunk: "🐿",
  Beaver: "🦫",
  Hedgehog: "🦔",
  Gorilla: "🦍",
  Monkey: "🐒",
  Chimp: "🦧",
  Horse: "🐴",
  Zebra: "🦓",
  Deer: "🦌",
  Giraffe: "🦒",
  Elephant: "🐘",
  Rhino: "🦏",
  Hippo: "🦛",
  Crocodile: "🐊",
  Snake: "🐍",
  Dino: "🦖",
  Bird: "🐦",
  Dodo: "🦤",
  Swan: "🦢",
  Parrot: "🦜",
  Peacock: "🦚",
  Seal: "🦭",
  Fish: "🐡",
  Shell: "🐚",
  Beetle: "🪲"
};

const stegcloak = new StegCloak(false, false)

const newPack = new Scene('newPack')

newPack.enter(async (ctx, next) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  const existingNewPack = ctx.session.scene.newPack || {}
  ctx.session.scene.newPack = existingNewPack

  if (ctx?.message?.text) {
    const args = ctx.message.text.split(' ')

    if (['fill', 'adaptive'].includes(args[1])) {
      ctx.session.scene.newPack.fillColor = true
    }
  }

  // Якщо це інлайн пак, пропускаємо вибір типу
  if (ctx.session.scene.newPack.inline) {
    return ctx.scene.enter('newPackTitle')
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_type'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.new_pack.regular')
      ],
      [
        ctx.i18n.t('scenes.new_pack.custom_emoji')
      ],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

newPack.on('message', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const { text } = ctx.message;
  const { newPack } = ctx.session.scene;
  if (text === ctx.i18n.t('scenes.new_pack.custom_emoji')) {
    newPack.packType = 'custom_emoji';
  } else if (text === ctx.i18n.t('scenes.new_pack.regular')) {
    newPack.packType = 'regular';
  } else {
    return ctx.scene.reenter();
  }

  if (
    ctx.session.scene?.copyPack
    && ctx.session.scene.copyPack.sticker_type !== newPack.packType
  ) {
    return ctx.scene.enter('newPackCopyPay')
  }

  return ctx.scene.enter('newPackTitle');
});

const newPackCopyPay = new Scene('newPackCopyPay')

newPackCopyPay.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.pay', {
    balance: ctx.session.userInfo.balance,
  }), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.copy.pay_btn')
      ],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

newPackCopyPay.hears(match('scenes.copy.pay_btn'), async (ctx) => {
  if (ctx.session.userInfo.balance < 1) {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.boost.error.not_enough_credits'), {
      reply_markup: Markup.removeKeyboard()
    })

    // Clean up all session state
    ctx.session.scene = {}
    return ctx.scene.leave()
  }
  return ctx.scene.enter('newPackTitle')
})

const choosePackFormat = new Scene('choosePackFormat')

choosePackFormat.enter(async (ctx, next) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_format'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.new_pack.static')
      ],
      [
        ctx.i18n.t('scenes.new_pack.video')
      ],
      [
        ctx.i18n.t('scenes.new_pack.animated')
      ],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

choosePackFormat.on('message', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  if (ctx.message.text === ctx.i18n.t('scenes.new_pack.animated')) {
    ctx.session.scene.newPack.animated = true
    return ctx.scene.enter('newPackTitle')
  } else if (ctx.message.text === ctx.i18n.t('scenes.new_pack.video')) {
    ctx.session.scene.newPack.video = true
    return ctx.scene.enter('newPackTitle')
  } else if (ctx.message.text === ctx.i18n.t('scenes.new_pack.static')) {
    ctx.session.scene.newPack.animated = false
    return ctx.scene.enter('newPackTitle')
  } else {
    return ctx.scene.reenter()
  }
})

const newPackTitle = new Scene('newPackTitle')

newPackTitle.enter(async (ctx) => {
  if (!ctx.session.scene) return ctx.scene.leave()
  if (!ctx.session.scene.newPack) {
    // Determine format from stickers if copyPack exists (StickerSet doesn't have is_video/is_animated)
    const copyPack = ctx.session.scene.copyPack
    ctx.session.scene.newPack = {
      animated: copyPack?.stickers?.some(s => s.is_animated) || false,
      video: copyPack?.stickers?.some(s => s.is_video) || false,
    }
  }

  const names = []

  const namesWithEmoji = uniqueNamesGenerator({
    dictionaries: [adjectives, Object.keys(animalEmojis)],
    separator: ' ',
    length: 2,
    style: 'capital'
  })

  // add emoji based on animal name in beginning of the line
  names.push(namesWithEmoji.replace(/(\w+)\s(\w+)/, (match, p1, p2) => `${animalEmojis[p2]} ${p1} ${p2}`))

  names.push(uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: ' ',
    length: 2,
    style: 'capital'
  }))

  names.push(uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: ' ',
    length: 3,
    style: 'capital'
  }))

  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_title'), {
    reply_markup: Markup.keyboard([
      ...names.map((name) => [name]),
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})
newPackTitle.on('text', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  let charTitleMax = ctx.config.charTitleMax

  let title = ctx.message.text

  if (countUncodeChars(title) > charTitleMax) {
    title = substrUnicode(title, 0, charTitleMax)
  }

  ctx.session.scene.newPack.title = title

  if (ctx.session.scene.newPack.inline) return ctx.scene.enter('newPackConfirm')
  else return ctx.scene.enter('newPackName')
})

const newPackName = new Scene('newPackName')

newPackName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  reply_to_message_id: ctx.message.message_id,
  allow_sending_without_reply: true,
  disable_web_page_preview: true,
}))

newPackName.on('text', async (ctx) => {
  // Ensure scene state exists
  if (!ctx.session.scene?.newPack) {
    return ctx.scene.enter('newPack')
  }

  ctx.session.scene.newPack.name = ctx.message.text

  return ctx.scene.enter('newPackConfirm')
})

const newPackConfirm = new Scene('newPackConfirm')

newPackConfirm.enter(async (ctx, next) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const copyPack = ctx.session.scene.copyPack
  const inline = !!ctx.session.scene.newPack.inline

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` :: @${ctx.options.username}`

  let { name, title, animated, video, fillColor, packType } = ctx.session.scene.newPack

  // Для inline паку автоматично генеруємо name
  if (inline) {
    name = 'inline_' + ctx.from.id
  } else {
    name = name.replace(/https/, '')
    name = name.replace(/t.me\/addstickers\//, '')
    name = slug(name, { separator: '_', maintainCase: true })
    name = name.replace(/[^0-9a-z_]/gi, '')
  }

  if (!name) {
    return ctx.scene.enter('newPackName')
  }

  const maxNameLength = 64 - nameSuffix.length

  if (name.length >= maxNameLength) {
    name = name.slice(0, maxNameLength)
  }

  if (!inline) name += nameSuffix
  if (!inline) title += titleSuffix

  let alreadyUploadedStickers = 0
  let createNewStickerSet
  let hasPlaceholder = false
  let failedBatchIndices = [] // Track failed stickers from batch for retry

  packType = packType || 'regular'

  if (inline) {
    createNewStickerSet = true
  } else {
    const stickerSetByName = await ctx.db.StickerSet.findOne({ name })

    if (stickerSetByName) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
      return ctx.scene.enter('newPackName')
    }

    if (copyPack) {
      const waitMessage = await ctx.replyWithHTML(ctx.i18n.t('⏳'), {
        reply_markup: {
          remove_keyboard: true
        }
      })

      const originalPackType = copyPack.sticker_type

      console.log('originalPackType', originalPackType)
      console.log('packType', packType)

      let uploadedStickers = []

      if (originalPackType === packType) {
        const stickers = copyPack.stickers.slice(0, 50)

        const batchResults = await Promise.all(stickers.map(async (sticker, originalIndex) => {
          let stickerFormat

          if (sticker.is_animated) {
            stickerFormat = 'animated'
          } else if (sticker.is_video) {
            stickerFormat = 'video'
          } else {
            stickerFormat = 'static'
          }

          let fileLink
          try {
            fileLink = await ctx.telegram.getFileLink(sticker.file_id)
          } catch (err) {
            return {
              error: {
                telegram: err
              },
              originalIndex
            }
          }

          const buffer = await got(fileLink, {
            responseType: 'buffer'
          }).then((response) => response.body).catch((err) => null)

          if (!buffer) {
            return {
              error: {
                telegram: new Error('Failed to download sticker')
              },
              originalIndex
            }
          }

          const uploadedSticker = await ctx.telegram.callApi('uploadStickerFile', {
            user_id: ctx.from.id,
            sticker_format: stickerFormat,
            sticker: {
              source: buffer
            }
          }).catch((error) => {
            return {
              error: {
                telegram: error
              }
            }
          })

          if (uploadedSticker.error) {
            return {
              error: {
                telegram: uploadedSticker.error.telegram
              },
              originalIndex
            }
          }

          return {
            sticker: uploadedSticker.file_id,
            format: stickerFormat,
            emoji_list: sticker.emojis ? sticker.emojis : [sticker.emoji],
            originalIndex
          }
        }))

        // Separate successful and failed stickers
        failedBatchIndices = batchResults
          .filter((result) => result.error)
          .map((result) => result.originalIndex)

        uploadedStickers = batchResults
          .filter((sticker) => !sticker.error)
          .sort((a, b) => a.originalIndex - b.originalIndex)

        // if < 90% of stickers uploaded in batch, fail completely
        if (uploadedStickers.length < stickers.length * 0.90) {
          await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id)

          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.upload_failed'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })

          // Clean up all session state
          ctx.session.scene = {}
          return ctx.scene.leave()
        }

        // Track how many were successfully uploaded in batch
        alreadyUploadedStickers = uploadedStickers.length
      } else {
        const uploadedSticker = await ctx.telegram.callApi('uploadStickerFile', {
          user_id: ctx.from.id,
          sticker_format: 'video',
          sticker: {
            source: placeholder[packType]['video']
          }
        })

        uploadedStickers = [
          {
            sticker: uploadedSticker.file_id,
            format: 'video',
            emoji_list: ['🌟'],
            placeholder: true
          }
        ]
      }

      // Clean up internal fields before API call (originalIndex, placeholder are internal only)
      const stickersForApi = uploadedStickers.map(({ sticker, format, emoji_list }) => ({
        sticker,
        format,
        emoji_list
      }))

      createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: stickersForApi,
        sticker_type: packType,
        needs_repainting: !!fillColor
      }).catch((error) => {
        return { error }
      })

      // Track if we need to delete placeholder after copying is complete
      hasPlaceholder = uploadedStickers[0]?.placeholder

      await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id)

      if (createNewStickerSet.error) {
        if (createNewStickerSet.error.description === 'STICKERSET_INVALID') {
          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          return ctx.scene.enter('newPackName')
        } else {
          return ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
            error: createNewStickerSet.error.description
          }), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
        }
      }
    } else {
      const uploadedSticker = await ctx.telegram.callApi('uploadStickerFile', {
        user_id: ctx.from.id,
        sticker_format: 'video',
        sticker: {
          source: placeholder[packType]['video']
        }
      })

      createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: [
          {
            sticker: uploadedSticker.file_id,
            format: 'video',
            emoji_list: ['🌟'],
          }
        ],
        sticker_type: packType,
        needs_repainting: !!fillColor
      }).catch((error) => {
        return { error }
      })

      if (createNewStickerSet.error) {
        const { error } = createNewStickerSet

        if (error.description === 'Bad Request: invalid sticker set name is specified') {
          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_invalid'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          return ctx.scene.enter('newPackName')
        } else if (error.description === 'Bad Request: sticker set name is already occupied') {
          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          return ctx.scene.enter('newPackName')
        } else {
          await ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
            error: error.description
          }), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          return ctx.scene.enter('newPackName')
        }
      }
    }
  }

  if (createNewStickerSet) {
    if (!inline && !ctx?.session?.scene?.copyPack) {
      setTimeout(async () => {
        const getStickerSet = await ctx.telegram.getStickerSet(name)
        const stickerInfo = getStickerSet.stickers[0]
        if (!stickerInfo) return

        await ctx.telegram.deleteStickerFromSet(stickerInfo.file_id).catch(error => {
          console.error('Error while deleting sticker from set: ', error)
        })
      }, 1000 * 10)
    }

    const userStickerSet = await ctx.db.StickerSet.newSet({
      owner: ctx.session.userInfo.id,
      ownerTelegramId: ctx.from.id,
      name,
      title,
      animated,
      inline,
      video,
      packType,
      boost: !!copyPack,
      emojiSuffix: '🌟',
      create: true
    })

    if (inline) {
      ctx.session.userInfo.inlineStickerSet = userStickerSet
      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_inline_pack', {
        title: escapeHTML(userStickerSet.title),
        botUsername: ctx.options.username
      }), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
        ])
      })
    } else {
      let inlineData = ''
      if (ctx.session.userInfo.inlineType === 'packs') {
        inlineData = stegcloak.hide('{gif}', '', ' : ')
      }

      const linkPrefix = userStickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_pack', {
        title: escapeHTML(userStickerSet.title),
        link: `${linkPrefix}${name}`
      }), {
        disable_web_page_preview: true,
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${linkPrefix}${userStickerSet.name}`)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.boost'), `boost:${userStickerSet.id}`, userStickerSet.boost)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.frame'), 'set_frame')
          ],
          [
            Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.btn.search_gif'), inlineData)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.coedit'), `coedit:${userStickerSet.id}`)
          ],
        ]),
        parse_mode: 'HTML'
      })
    }

    ctx.session.userInfo.stickerSet = userStickerSet

    // if different pack type, use atomic $inc to prevent race conditions
    if (copyPack && copyPack.sticker_type !== packType) {
      await ctx.db.User.updateOne(
        { _id: ctx.session.userInfo._id },
        { $inc: { balance: -1 }, $set: { stickerSet: userStickerSet._id } }
      )
      ctx.session.userInfo.balance -= 1
    } else {
      await ctx.db.User.updateOne(
        { _id: ctx.session.userInfo._id },
        { $set: { stickerSet: userStickerSet._id } }
      )
    }

    if (!copyPack) {
      await ctx.replyWithHTML('👌', {
        reply_markup: {
          remove_keyboard: true
        }
      })

      return ctx.scene.leave()
    }

    const originalPack = copyPack

    // Calculate how many stickers need to be added via addSticker
    // For same type: stickers after batch (index >= 50) + failed batch stickers
    // For different type (placeholder flow): ALL stickers need individual copy
    const batchAttemptedCount = hasPlaceholder ? 0 : Math.min(50, originalPack.stickers.length)
    const needsIndividualCopy = hasPlaceholder || originalPack.stickers.length > batchAttemptedCount || failedBatchIndices.length > 0

    if (needsIndividualCopy) {
      const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.progress', {
        originalTitle: escapeHTML(originalPack.title),
        originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
        title: escapeHTML(title),
        link: `${ctx.config.stickerLinkPrefix}${name}`,
        current: alreadyUploadedStickers,
        total: originalPack.stickers.length
      }))

      let successCount = alreadyUploadedStickers
      let failedCount = 0
      let pendingCount = 0 // Stickers queued for async processing (video conversion)
      let processed = 0

      // First, retry failed batch stickers
      for (const failedIndex of failedBatchIndices) {
        const result = await addSticker(ctx, originalPack.stickers[failedIndex], userStickerSet, false)

        if (result?.error) {
          failedCount++
        } else if (result?.wait) {
          // Video stickers queued for async processing - don't count as success yet
          pendingCount++
        } else {
          successCount++
        }
        processed++

        if (processed % 10 === 0) {
          await ctx.telegram.editMessageText(
            message.chat.id, message.message_id, null,
            ctx.i18n.t('scenes.copy.progress', {
              originalTitle: escapeHTML(originalPack.title),
              originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
              title: escapeHTML(title),
              link: `${ctx.config.stickerLinkPrefix}${name}`,
              current: successCount + pendingCount,
              total: originalPack.stickers.length
            }),
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }
      }

      // Then, continue with stickers after batch (index >= 50)
      for (let index = batchAttemptedCount; index < originalPack.stickers.length; index++) {
        const result = await addSticker(ctx, originalPack.stickers[index], userStickerSet, false)

        if (result?.error) {
          failedCount++
        } else if (result?.wait) {
          // Video stickers queued for async processing - don't count as success yet
          pendingCount++
        } else {
          successCount++
        }
        processed++

        if (processed % 10 === 0) {
          await ctx.telegram.editMessageText(
            message.chat.id, message.message_id, null,
            ctx.i18n.t('scenes.copy.progress', {
              originalTitle: escapeHTML(originalPack.title),
              originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
              title: escapeHTML(title),
              link: `${ctx.config.stickerLinkPrefix}${name}`,
              current: successCount + pendingCount,
              total: originalPack.stickers.length
            }),
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }
      }

      await ctx.telegram.deleteMessage(message.chat.id, message.message_id)

      // Show result with appropriate message based on outcome
      if (failedCount > 0 && pendingCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_partial_pending', {
            originalTitle: escapeHTML(originalPack.title),
            originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
            title: escapeHTML(title),
            link: `${ctx.config.stickerLinkPrefix}${name}`,
            success: successCount,
            failed: failedCount,
            pending: pendingCount
          }),
          { parse_mode: 'HTML' }
        )
      } else if (failedCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_partial', {
            originalTitle: escapeHTML(originalPack.title),
            originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
            title: escapeHTML(title),
            link: `${ctx.config.stickerLinkPrefix}${name}`,
            success: successCount,
            failed: failedCount
          }),
          { parse_mode: 'HTML' }
        )
      } else if (pendingCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_pending', {
            originalTitle: escapeHTML(originalPack.title),
            originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
            title: escapeHTML(title),
            link: `${ctx.config.stickerLinkPrefix}${name}`,
            success: successCount,
            pending: pendingCount
          }),
          { parse_mode: 'HTML' }
        )
      } else {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done', {
            originalTitle: escapeHTML(originalPack.title),
            originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
            title: escapeHTML(title),
            link: `${ctx.config.stickerLinkPrefix}${name}`
          }),
          { parse_mode: 'HTML' }
        )
      }
    }

    // Delete placeholder sticker after all stickers are copied
    if (hasPlaceholder) {
      const getStickerSet = await ctx.telegram.getStickerSet(name).catch(() => null)
      if (getStickerSet?.stickers?.length > 1) {
        // Delete placeholder only if there are other stickers
        const placeholderSticker = getStickerSet.stickers[0]
        if (placeholderSticker) {
          await ctx.telegram.deleteStickerFromSet(placeholderSticker.file_id).catch(error => {
            console.error('Error while deleting placeholder sticker: ', error)
          })
        }
      } else if (getStickerSet?.stickers?.length === 1 && successCount === 0 && pendingCount === 0) {
        // All stickers failed - pack only has placeholder
        // Delete the entire pack since it's useless
        await ctx.telegram.callApi('deleteStickerSet', { name }).catch(error => {
          console.error('Error while deleting empty sticker set: ', error)
        })
        // Remove from database
        await ctx.db.StickerSet.deleteOne({ name }).catch(() => {})
        // Warn user
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.error.all_failed', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`
        }))
      }
    }

    // Clean up session state
    delete ctx.session.scene.copyPack

    await ctx.scene.leave()
  }
})

module.exports = [
  newPack,
  choosePackFormat,
  newPackTitle,
  newPackName,
  newPackConfirm,
  newPackCopyPay
]
