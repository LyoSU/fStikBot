const Markup = require('telegraf/markup')
const { sendBanner, editBanner } = require('../banners')
const { sendPackMenu, isOwner } = require('./pack-menu')
const { flushPendingStickers } = require('./sticker')
const coedit = require('../utils/coedit')

const PAGE_SIZE = 10
const PACK_TYPES = ['regular', 'custom_emoji', 'inline']
// Tabs also include packs other people shared with the user.
const VIEW_TYPES = [...PACK_TYPES, 'shared']

const typeFilter = (packType) => {
  if (packType === 'inline') return { inline: true }
  return {
    inline: { $ne: true },
    packType: packType === 'regular' ? { $in: ['regular', null] } : packType
  }
}

const selectedType = (userInfo) => {
  if (userInfo.stickerSet?.inline) return 'inline'
  return userInfo.stickerSet?.packType || 'regular'
}

// Which list to show, from the button that was pressed:
//   packs:type:<type>                  a tab
//   packs:list:<type>:<page>           a page of a tab
//   packs:hidden:<type>:<page>         hidden packs of a tab
//   packs:<page> / packs:null          older messages — the selected pack's tab
// The tab and page travel in the button. Switching tabs used to select that
// tab's newest pack (or none), so just looking at "Emoji" made the next photo
// fail with "no pack selected".
const parseView = (ctx) => {
  const view = { packType: selectedType(ctx.session.userInfo), page: 0, hidden: false }
  if (ctx.state.type) view.packType = ctx.state.type

  const data = ctx.callbackQuery?.data || ''
  const [, kind, type, page] = data.split(':')

  if (kind === 'type' || kind === 'list' || kind === 'hidden') {
    if (VIEW_TYPES.includes(type)) view.packType = type
    view.page = Math.max(0, parseInt(page, 10) || 0)
    view.hidden = kind === 'hidden'
  } else if (data.startsWith('packs:')) {
    view.page = Math.max(0, parseInt(kind, 10) || 0)
  }

  return view
}

// The inline pack is created on first visit to the inline tab.
const ensureInlinePack = async (ctx) => {
  const { userInfo } = ctx.session
  const existing = await ctx.db.StickerSet.findOne({ owner: userInfo.id, inline: true, deleted: { $ne: true } })
  if (existing) return existing

  return ctx.db.StickerSet.newSet({
    owner: userInfo.id,
    ownerTelegramId: ctx.from.id,
    name: 'inline_' + ctx.from.id,
    title: ctx.i18n.t('cmd.packs.inline_title'),
    emojiSuffix: '💫',
    create: true,
    inline: true
  })
}

const packCount = async (ctx, view, query, pageSize) => {
  const { userInfo } = ctx.session
  // Cached on the user document; counted (and cached) when missing.
  let total = userInfo.packsCount?.[view.packType] ?? 0
  if (total === 0 && pageSize > 0) {
    total = await ctx.db.StickerSet.countDocuments(query)
    if (!userInfo.packsCount) userInfo.packsCount = {}
    userInfo.packsCount[view.packType] = total
    ctx.db.User.updateOne({ _id: userInfo._id }, { $set: { [`packsCount.${view.packType}`]: total } }).catch(() => {})
  }
  return total
}

async function renderList (ctx, view) {
  const { userInfo } = ctx.session
  const t = (key) => ctx.i18n.t(key)

  const shared = view.packType === 'shared'
  const query = shared
    ? { 'editors.user': userInfo._id, create: true, deleted: { $ne: true } }
    : { owner: userInfo.id, create: true, hide: view.hidden ? true : { $ne: true }, ...typeFilter(view.packType) }

  // limit+1 tells whether there is a next page without a count query.
  const stickerSets = await ctx.db.StickerSet.find(query)
    .sort({ updatedAt: -1 })
    .skip(view.page * PAGE_SIZE)
    .limit(PAGE_SIZE + 1)
    .lean()

  const hasNextPage = stickerSets.length > PAGE_SIZE
  if (hasNextPage) stickerSets.pop()

  if (view.packType === 'inline' && !view.hidden && view.page === 0 && stickerSets.length === 0) {
    const inlineSet = await ensureInlinePack(ctx)
    if (inlineSet.hide !== true) stickerSets.push(inlineSet)
  }

  const keyboard = []
  let text

  if (view.hidden) {
    text = t(stickerSets.length > 0 ? 'cmd.packs.hidden_info' : 'cmd.packs.hidden_empty')
  } else if (stickerSets.length > 0) {
    const total = shared ? await ctx.db.StickerSet.countDocuments(query) : await packCount(ctx, view, query, stickerSets.length)
    text = t('cmd.packs.info')
    if (total > PAGE_SIZE) text += `\n<i>${view.page + 1}/${Math.ceil(total / PAGE_SIZE)} (${total})</i>\n`
  } else {
    text = t('cmd.packs.empty')
  }

  const selectedId = String(userInfo.stickerSet?._id || '')
  for (const pack of stickerSets) {
    const mark = String(pack._id) === selectedId ? ' ✅' : ''
    keyboard.push([Markup.callbackButton(pack.title + mark, `set_pack:${pack._id}`)])
  }

  if (view.packType === 'inline' && !view.hidden) {
    const gifTitle = userInfo.inlineType === 'gif' ? '✅ GIF' : 'GIF'
    keyboard.push([Markup.callbackButton(gifTitle, 'set_pack:gif')])
  }

  const listKind = view.hidden ? 'hidden' : 'list'
  const pagination = []
  if (view.page > 0) pagination.push(Markup.callbackButton(`‹ ${view.page}`, `packs:${listKind}:${view.packType}:${view.page - 1}`))
  if (hasNextPage) pagination.push(Markup.callbackButton(`${view.page + 2} ›`, `packs:${listKind}:${view.packType}:${view.page + 1}`))
  if (pagination.length) keyboard.push(pagination)

  if (view.hidden) {
    keyboard.push([Markup.callbackButton(ctx.i18n.t('cmd.guide.btn.back'), `packs:list:${view.packType}:0`)])
  } else {
    keyboard.push(PACK_TYPES.map((type) => Markup.callbackButton(
      (view.packType === type ? '✅ ' : '') + t(`cmd.packs.types.${type}`),
      `packs:type:${type}`
    )))

    const [hasShared, hasHidden] = await Promise.all([
      ctx.db.StickerSet.exists({ 'editors.user': userInfo._id, deleted: { $ne: true } }),
      !shared && ctx.db.StickerSet.exists({ owner: userInfo.id, create: true, hide: true, ...typeFilter(view.packType) })
    ])
    if (hasShared) {
      keyboard.push([Markup.callbackButton((shared ? '✅ ' : '') + t('cmd.packs.types.shared'), 'packs:type:shared')])
    }
    // Only one inline pack per user — its name is fixed, a second would wipe it.
    const canCreate = !['inline', 'shared'].includes(view.packType)
    keyboard.push([
      canCreate && Markup.callbackButton(t('cmd.start.btn.new'), `new_pack:${view.packType}`),
      hasHidden && Markup.callbackButton(t('cmd.packs.hidden_btn'), `packs:hidden:${view.packType}:0`)
    ].filter(Boolean))
  }

  const extra = { reply_markup: Markup.inlineKeyboard(keyboard.filter((row) => row.length > 0)) }

  if (ctx.callbackQuery) return editBanner(ctx, 'packs', text, extra)
  return sendBanner(ctx, 'packs', text, {
    ...extra,
    reply_to_message_id: ctx.message?.message_id,
    allow_sending_without_reply: true
  })
}

// set_pack:<id> — open a pack from the list. A visible pack is selected (new
// stickers go there); a hidden one just shows its restore/delete menu.
async function openPack (ctx) {
  const { userInfo } = ctx.session
  const id = ctx.match[2]

  if (id === 'gif') {
    userInfo.inlineType = 'gif'
    if (userInfo.stickerSet?.inline) userInfo.stickerSet = null
    userInfo.inlineStickerSet = null
    await ctx.answerCbQuery()
    return renderList(ctx, { packType: 'inline', page: 0, hidden: false })
  }

  const stickerSet = await ctx.db.StickerSet.findById(id).catch(() => null)
  if (!stickerSet || stickerSet.deleted) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
  }
  const owner = isOwner(ctx, stickerSet)
  if (!owner && !coedit.can(await coedit.getAccess(ctx, stickerSet), 'add')) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
  }

  await ctx.answerCbQuery()

  if (stickerSet.hide !== true || !owner) {
    if (owner) {
      stickerSet.updatedAt = new Date()
      await ctx.db.StickerSet.updateOne({ _id: stickerSet._id }, { updatedAt: stickerSet.updatedAt })
    }

    if (stickerSet.inline) {
      userInfo.inlineType = 'packs'
      userInfo.inlineStickerSet = stickerSet
    }
    userInfo.stickerSet = stickerSet
  }

  await sendPackMenu(ctx, stickerSet)

  if (stickerSet.hide !== true || !owner) {
    flushPendingStickers(ctx, stickerSet)
    // Refresh the ✅ mark in the list the pack was opened from.
    const packType = !owner ? 'shared' : (stickerSet.inline ? 'inline' : (stickerSet.packType || 'regular'))
    await renderList(ctx, { packType, page: 0, hidden: false })
  }
}

module.exports = async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.packs.select_group_pack_info'), {
      reply_markup: Markup.inlineKeyboard([
        Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_group_pack'), 'select_group_pack')
      ]),
      reply_to_message_id: ctx.message?.message_id,
      allow_sending_without_reply: true
    })
  }

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  if (ctx.callbackQuery && ctx.match?.[1] === 'set_pack') return openPack(ctx)

  return renderList(ctx, parseView(ctx))
}
