const Markup = require('telegraf/markup')
const { escapeHTML, userName } = require('../utils')
const packLink = require('../utils/pack-link')
const { sendBanner } = require('../banners')
const metrics = require('../utils/metrics')

// "Stickers go to: <pack>" — the one thing a returning user needs to know
// before sending a photo.
const currentPackLine = (ctx) => {
  const pack = ctx.session.userInfo?.stickerSet
  if (!pack?.name || pack.inline) return ''
  return '\n\n' + ctx.i18n.t('cmd.start.current_pack', {
    title: escapeHTML(pack.title),
    link: packLink(pack)
  })
}

module.exports = async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from.is_bot) {
    return ctx.deleteMessage()
  }

  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.start.group', {
      // A group called "Tom & Jerry" broke entity parsing and the bot stayed
      // silent after being added.
      groupTitle: escapeHTML(ctx.chat.title)
    }), {
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_group_pack'), 'select_group_pack')
        ]
      ])
    })
  }

  // Only "has at least one pack" matters here; exists() stops at the first match.
  const hasStickerSets = await ctx.db.StickerSet.exists({ owner: ctx.session.userInfo.id })
  metrics.track(hasStickerSets ? 'start_returning' : 'start_new')

  const keyboard = [
    hasStickerSets
      ? [
          Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null'),
          Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')
        ]
      : [Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.search_catalog'), 'search_catalog'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.info'), 'pack_about')
    ],
    [
      Markup.urlButton(ctx.i18n.t('cmd.start.commands.guide'), 'https://fstik.app/guides'),
      Markup.urlButton(ctx.i18n.t('cmd.start.commands.add_to_group'), `https://t.me/${ctx.botInfo.username}?startgroup=bot`)
    ]
  ]

  let messageText = ctx.i18n.t('cmd.start.enter', { name: userName(ctx.from) }) + currentPackLine(ctx)

  if (ctx.config?.advertising?.text && ctx.config?.advertising?.link) {
    messageText += `\n\n<a href="${ctx.config.advertising.link}">${ctx.config.advertising.text}</a>`
  }

  await sendBanner(ctx, 'welcome', messageText, {
    reply_markup: Markup.inlineKeyboard(keyboard)
  })

  ctx.telegram.callApi('deleteMyCommands', {
    scope: {
      type: 'chat',
      chat_id: ctx.chat.id
    }
  }).catch(err => console.error('Failed to delete chat commands:', err.message))
}

// A private message nothing else understood. Someone with a pack gets a short
// reminder of what to send and where it goes; the whole welcome banner used to
// be re-sent for every stray message.
module.exports.hint = async (ctx) => {
  const pack = ctx.session.userInfo?.stickerSet
  if (!pack?.name) return module.exports(ctx)

  return ctx.replyWithHTML(ctx.i18n.t('cmd.start.hint', {
    title: escapeHTML(pack.title),
    link: pack.inline ? `t.me/${ctx.options.username}` : packLink(pack)
  }), {
    reply_to_message_id: ctx.message?.message_id,
    allow_sending_without_reply: true,
    disable_web_page_preview: true,
    reply_markup: Markup.inlineKeyboard([[
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')
    ]])
  })
}
