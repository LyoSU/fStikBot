const StegCloak = require('stegcloak')
const Markup = require('telegraf/markup')

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

module.exports = async (ctx) => {
  const { userInfo } = ctx.session

  if (!userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const query = {
    owner: userInfo.id,
    create: true,
    hide: { $ne: true }
  }

  let page = 0
  let limit = 10

  if (ctx.callbackQuery) {
    page = parseInt(ctx.match[1]) || 0
  }
  if (page < 0) page = 0

  if (ctx.callbackQuery && ctx.match && ctx.match[1] === 'set_pack') {
    if (ctx.match[2] === 'gif') {
      ctx.session.userInfo.inlineType = 'gif'
      if (userInfo?.stickerSet?.inline) userInfo.stickerSet = null
      userInfo.inlineStickerSet = null
    } else {
      const stickerSet = await ctx.db.StickerSet.findById(ctx.match[2])

      stickerSet.updatedAt = new Date()
      await stickerSet.save()

      if (!stickerSet) {
        return ctx.answerCbQuery('error', true)
      }

      if (stickerSet?.owner.toString() === userInfo.id.toString()) {
        await ctx.answerCbQuery()

        if (stickerSet.inline) {
          ctx.session.userInfo.inlineType = 'packs'
          userInfo.inlineStickerSet = stickerSet
          userInfo.animatedStickerSet = null
        }

        if (stickerSet.video) {
          userInfo.videoStickerSet = stickerSet
          userInfo.stickerSet = stickerSet
        } else if (stickerSet.animated) {
          userInfo.animatedStickerSet = stickerSet
          if (userInfo?.stickerSet?.inline) {
            userInfo.stickerSet = null
          }
        } else {
          userInfo.stickerSet = stickerSet
        }

        const btnName = stickerSet.hide === true ? 'callback.pack.btn.restore' : 'callback.pack.btn.hide'

        if (stickerSet.inline) {
          await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_inline_pack', {
            title: escapeHTML(stickerSet.title),
            botUsername: ctx.options.username
          }), {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
              ],
              [
                Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
              ]
            ]),
            parse_mode: 'HTML'
          })
        } else {
          let searchGifButton = []

          if(stickerSet.video) {
            let inlineData = ''
            if (ctx.session.userInfo.inlineType === 'packs') {
              inlineData = stegcloak.hide('{gif}', '', ' : ')
            }

            searchGifButton = [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.btn.search_gif'), inlineData)]
          }

          let coeditButton = []

          if (stickerSet.owner.toString() === userInfo.id.toString()) {
            coeditButton = [Markup.callbackButton(ctx.i18n.t('callback.pack.btn.coedit'), `coedit:${stickerSet.id}`)]
          }

          let catalogButton = []

          const stickersCount = await ctx.db.Sticker.countDocuments({
            stickerSet: stickerSet.id,
            deleted: false
          })

          if (stickerSet.public) {
            catalogButton = [
              Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_delete'), `catalog:remove:${stickerSet.id}`),
              Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_edit'), `catalog:publish:${stickerSet.id}`)
            ]
          } else if (!stickerSet.animated && !stickerSet.inline && stickersCount >= 10) {
            catalogButton = [Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_add'), `catalog:publish:${stickerSet.id}`)]
          }

          let type = 'static'
          if (stickerSet.animated) type = 'animated'
          if (stickerSet.video) type = 'video'

          await ctx.replyWithHTML(ctx.i18n.t(`callback.pack.set_pack.${type}`, {
            title: escapeHTML(stickerSet.title),
            link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
          }), {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${ctx.config.stickerLinkPrefix}${stickerSet.name}`)
              ],
              searchGifButton,
              coeditButton,
              catalogButton,
              [
                Markup.callbackButton(ctx.i18n.t(btnName), `hide_pack:${stickerSet.id}`)
              ]
            ]),
            parse_mode: 'HTML'
          })

          if (stickerSet.video && !stickerSet.frameType) {
            return ctx.scene.enter('packFrame')
          }
        }
      } else {
        await ctx.answerCbQuery('error', true)
      }
    }
  }

  if (ctx.state.type === 'inline') {
    query.inline = true
  }

  const stickerSets = await ctx.db.StickerSet.find(query).sort({
    updatedAt: -1
  })
  .sort({
    updatedAt: -1
  })
  .limit(limit)
  .skip(page * limit)

  if (ctx.state.type === 'inline' && stickerSets.length <= 0) {
    let inlineSet = await ctx.db.StickerSet.findOne({
      owner: userInfo.id,
      inline: true
    })

    if (!inlineSet) {
      inlineSet = await ctx.db.StickerSet.newSet({
        owner: userInfo.id,
        name: 'inline_' + ctx.from.id,
        title: ctx.i18n.t('cmd.packs.inline_title'),
        emojiSuffix: '💫',
        create: true,
        inline: true
      })
    }

    stickerSets.unshift(inlineSet)
  }

  let messageText = ''
  const keyboardMarkup = []

  if (stickerSets.length > 0) {
    messageText = ctx.i18n.t('cmd.packs.info')

    stickerSets.forEach((pack) => {
      let { title } = pack

      if (pack.video === true) title = `📹 ${title}`
      else if (pack.animated === true) title = `✨ ${title}`
      else if (pack.inline === true) title = `💫 ${title}`
      else title = `🌟 ${title}`

      if (
        userInfo.stickerSet?.id.toString() === pack.id.toString() ||
        userInfo.animatedStickerSet?.id.toString() === pack.id.toString() ||
        userInfo.videoStickerSet?.id.toString() === pack.id.toString()
      ) title += ` ✅`

      keyboardMarkup.push([Markup.callbackButton(title, `set_pack:${pack.id}`)])
    })
  } else {
    messageText = ctx.i18n.t('cmd.packs.empty')
  }

  if (ctx.state.type === 'inline') {
    const title = ctx.session.userInfo.inlineType !== 'gif' ? 'GIF' : '✅ GIF'
    keyboardMarkup.push([Markup.callbackButton(title, 'set_pack:gif')])
  }

  const stickerSetsCount = await ctx.db.StickerSet.count(query)

  const paginationKeyboard = []

  if (page > 0) {
    paginationKeyboard.push(Markup.callbackButton('◀️', `packs:${page - 1}`))
  }
  if (stickerSetsCount > (page + 1) * limit) {
    paginationKeyboard.push(Markup.callbackButton('▶️', `packs:${page + 1}`))
  }

  keyboardMarkup.push(paginationKeyboard)

  keyboardMarkup.push([Markup.callbackButton(ctx.i18n.t('cmd.start.btn.new'), 'new_pack')])

  if (ctx.updateType === 'message') {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: Markup.inlineKeyboard(keyboardMarkup)
    })
  } else if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(messageText, {
      reply_markup: Markup.inlineKeyboard(keyboardMarkup),
      parse_mode: 'HTML'
    }).catch(() => {})
  }
}
