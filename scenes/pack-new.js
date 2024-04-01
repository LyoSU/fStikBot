const got = require('got')
const StegCloak = require('stegcloak')
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { uniqueNamesGenerator, adjectives, colors, animals } = require('unique-names-generator');

const {
  addSticker,
  countUncodeChars,
  substrUnicode,
} = require('../utils')

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
  Hourse: "🐴",
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

const escapeHTML = (str) => str.replace(
  /[&<>'"]/g,
  (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

const newPack = new Scene('newPack')

newPack.enter(async (ctx, next) => {
  ctx.session.scene.newPack = {}

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
  const { text } = ctx.message;
  const { newPack } = ctx.session.scene;
  if (text === ctx.i18n.t('scenes.new_pack.custom_emoji')) {
    newPack.packType = 'custom_emoji';
  } else if (text === ctx.i18n.t('scenes.new_pack.regular')) {
    newPack.packType = 'regular';
  } else {
    return ctx.scene.reenter();
  }
  return ctx.scene.enter('newPackTitle');
});

const сhoosePackFormat = new Scene('сhoosePackFormat')

сhoosePackFormat.enter(async (ctx, next) => {
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

сhoosePackFormat.on('message', async (ctx) => {
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
  if (!ctx.session.scene.newPack) ctx.session.scene.newPack = {
    animated: ctx.session.scene.copyPack.is_animated,
    video: ctx.session.scene.copyPack.is_video,
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
  allow_sending_without_reply: true
}))

newPackName.on('text', async (ctx) => {
  ctx.session.scene.newPack.name = ctx.message.text

  return ctx.scene.enter('newPackConfirm')
})

const newPackConfirm = new Scene('newPackConfirm')

newPackConfirm.enter(async (ctx, next) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const inline = !!ctx.session.scene?.newPack?.inline

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` :: @${ctx.options.username}`

  let { name, title, animated, video } = ctx.session.scene.newPack

  if (!ctx.session.scene.newPack.inline) {
    name = name.replace(/https/, '')
    name = name.replace(/t.me\/addstickers\//, '')
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

  let createNewStickerSet

  const packType = ctx.session.scene.newPack.packType || 'regular'

  if (inline) {
    createNewStickerSet = true
  } else {
    const stickerFormat = animated ? 'animated' : video ? 'video' : 'static'

    const stickerSetByName = await ctx.db.StickerSet.findOne({ name })

    if (stickerSetByName) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
      return ctx.scene.enter('newPackName')
    }

    if (ctx.session.scene.copyPack) {
      const waitMessage = await ctx.replyWithHTML(ctx.i18n.t('⏳'), {
        reply_markup: {
          remove_keyboard: true
        }
      })

      const stickers = ctx.session.scene.copyPack.stickers.slice(0, 50)

      const uploadedStickers = (await Promise.all(stickers.map(async (sticker) => {
        const fileLink = await ctx.telegram.getFileLink(sticker.file_id)

        const buffer = await got(fileLink, {
          responseType: 'buffer'
        }).then((response) => response.body)

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
            }
          }
        }

        return {
          sticker: uploadedSticker.file_id,
          emoji_list: [sticker.emoji]
        }
      }))).sort((a, b) => {
        const aIndex = stickers.findIndex((sticker) => sticker.file_id === a.sticker)
        const bIndex = stickers.findIndex((sticker) => sticker.file_id === b.sticker)

        return aIndex - bIndex
      })

      if (uploadedStickers.some((sticker) => sticker.error)) {
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id)

        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.upload_failed'), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })

        return ctx.scene.leave()
      }

      createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: uploadedStickers,
        sticker_format: stickerFormat,
        sticker_type: packType,
        needs_repainting: !!ctx.session.scene.newPack.fillColor
      }).catch((error) => {
        return { error }
      })

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
        sticker_format: 'animated',
        sticker: {
          source: placeholder[packType]['animated']
        }
      })

      createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: [
          {
            sticker: uploadedSticker.file_id,
            format: 'animated',
            emoji_list: ['🌟'],
          }
        ],
        sticker_type: packType,
        needs_repainting: !!ctx.session.scene.newPack.fillColor
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
    if (!inline && !ctx.session.scene.copyPack) {
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
      name,
      title,
      animated,
      inline,
      video,
      packType,
      emojiSuffix: '🌟',
      create: true
    })

    ctx.session.userInfo.stickerSet = userStickerSet

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
      let searchGifBtn = []

      if(userStickerSet.video) {
        let inlineData = ''
        if (ctx.session.userInfo.inlineType === 'packs') {
          inlineData = stegcloak.hide('{gif}', '', ' : ')
        }

        searchGifBtn = [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.btn.search_gif'), inlineData)]
      }

      const linkPrefix = userStickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_pack.video', {
        title: escapeHTML(userStickerSet.title),
        link: `${linkPrefix}${name}`
      }), {
        disable_web_page_preview: true,
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${linkPrefix}${userStickerSet.name}`)
          ],
          searchGifBtn
        ]),
        parse_mode: 'HTML'
      })
    }

    if (!ctx.session.scene.copyPack) {
      await ctx.replyWithHTML('👌', {
        reply_markup: {
          remove_keyboard: true
        }
      })

      return ctx.scene.leave()
    }

    const originalPack = ctx.session.scene.copyPack

    if (originalPack.stickers.length > 50) {
      const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.progress', {
        originalTitle: originalPack.title,
        originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
        title: escapeHTML(title),
        link: `${ctx.config.stickerLinkPrefix}${name}`,
        current: 50,
        total: originalPack.stickers.length
      }))

      for (let index = 50; index < originalPack.stickers.length; index++) {
        await addSticker(ctx, originalPack.stickers[index], userStickerSet)

        if (index % 10 === 0) {
          await ctx.telegram.editMessageText(
            message.chat.id, message.message_id, null,
            ctx.i18n.t('scenes.copy.progress', {
              originalTitle: originalPack.title,
              originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
              title: escapeHTML(title),
              link: `${ctx.config.stickerLinkPrefix}${name}`,
              current: index,
              total: originalPack.stickers.length
            }),
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }
      }

      await ctx.telegram.deleteMessage(message.chat.id, message.message_id)

      await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done', {
          originalTitle: originalPack.title,
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`
        }),
        { parse_mode: 'HTML' }
      )
    }

    await ctx.scene.leave()
  }
})

module.exports = [
  newPack,
  сhoosePackFormat,
  newPackTitle,
  newPackName,
  newPackConfirm
]
