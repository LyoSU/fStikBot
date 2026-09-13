const crypto = require('crypto')
const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const escapeHTML = require('../utils/html-escape')
const packLink = require('../utils/pack-link')
const coedit = require('../utils/coedit')

const MEMBERS_SHOWN = 20
const ACTIVITY_PAGE = 15
const ROLE_ICON = { editor: '✏️', contributor: '➕' }

const generatePasscode = () => crypto.randomBytes(16).toString('hex')

const composer = new Composer()

const show = (ctx, text, keyboard) => {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: Markup.inlineKeyboard(keyboard) }
  return ctx.editMessageText(text, extra).catch(() => ctx.replyWithHTML(text, extra))
}

const coeditLink = (ctx, pack) => `t.me/${ctx.botInfo.username}?start=s_${pack.passcode}`

// The pack, if the caller owns it.
const loadOwned = async (ctx, id) => {
  const pack = await ctx.db.StickerSet.findById(id).catch(() => null)
  if (!pack || pack.deleted) {
    await ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)
    return null
  }
  if (coedit.idOf(pack.owner) !== coedit.idOf(ctx.session.userInfo)) {
    await ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_owner'), true)
    return null
  }
  return pack
}

// Users who got in through the link before the member list existed.
const adoptLegacyEditors = async (ctx, pack) => {
  if (pack.coedit?.migrated) return

  const known = new Set((pack.editors || []).map((entry) => coedit.idOf(entry.user)))
  const legacy = await ctx.db.User.find({ stickerSet: pack._id, _id: { $ne: pack.owner } })
    .select('_id telegram_id first_name last_name username')
    .limit(200)
    .lean()

  for (const user of legacy) {
    if (known.has(String(user._id))) continue
    pack.editors.push({
      user: user._id,
      telegramId: user.telegram_id,
      name: coedit.displayName({ ...user, id: user.telegram_id }),
      role: coedit.DEFAULT_ROLE,
      addedAt: new Date()
    })
  }

  pack.coedit = { ...(pack.coedit?.toObject ? pack.coedit.toObject() : pack.coedit), migrated: true }
  await pack.save()
}

const renderMenu = async (ctx, pack, notice) => {
  const t = (key, params) => ctx.i18n.t(key, params)
  if (!pack.passcode) {
    pack.passcode = generatePasscode()
    await pack.save()
  }
  await adoptLegacyEditors(ctx, pack)

  const members = pack.editors || []
  const defaultRole = pack.coedit?.defaultRole || coedit.DEFAULT_ROLE
  const text = [
    notice,
    t('coedit.info', {
      title: escapeHTML(pack.title),
      link: packLink(pack),
      colink: coeditLink(ctx, pack),
      defaultRole: coedit.roleLabel(t, defaultRole),
      count: members.length
    })
  ].filter(Boolean).join('\n\n')

  const shareText = encodeURIComponent(t('coedit.share', { title: pack.title }))
  const keyboard = [
    [Markup.urlButton(t('coedit.btn.send'), `https://t.me/share/url?url=${coeditLink(ctx, pack)}&text=${shareText}`)],
    ...members.slice(0, MEMBERS_SHOWN).map((member) => [
      Markup.callbackButton(`${ROLE_ICON[member.role] || ROLE_ICON.editor} ${member.name}`, `ce:u:${pack._id}:${member.user}`)
    ]),
    [
      Markup.callbackButton(t('coedit.btn.activity'), `ce:log:${pack._id}:0`),
      Markup.callbackButton(t('coedit.btn.default_role', { role: coedit.roleLabel(t, defaultRole) }), `ce:def:${pack._id}`)
    ],
    [
      Markup.callbackButton(t('coedit.btn.reset'), `coedit:reset:${pack._id}`),
      ...(members.length ? [{ ...Markup.callbackButton(t('coedit.btn.clear'), `ce:clear:${pack._id}`), style: 'danger' }] : [])
    ],
    [Markup.callbackButton(t('coedit.btn.back'), `pack_menu:${pack._id}`)]
  ]

  return show(ctx, text, keyboard)
}

const findMember = (pack, userId) => (pack.editors || []).find((entry) => coedit.idOf(entry.user) === userId)

const renderMember = async (ctx, pack, member) => {
  const t = (key, params) => ctx.i18n.t(key, params)
  const actions = await ctx.db.PackActivity.countDocuments({ stickerSet: pack._id, 'actor.telegramId': member.telegramId })
  const role = member.role || coedit.DEFAULT_ROLE
  const mark = (value) => (role === value ? '✅ ' : '')

  return show(ctx, t('coedit.member', {
    name: escapeHTML(member.name),
    role: coedit.roleLabel(t, role),
    date: member.addedAt ? member.addedAt.toISOString().slice(0, 10) : '—',
    actions
  }), [
    [
      Markup.callbackButton(mark('editor') + t('coedit.btn.role_editor'), `ce:r:${pack._id}:${member.user}:e`),
      Markup.callbackButton(mark('contributor') + t('coedit.btn.role_contributor'), `ce:r:${pack._id}:${member.user}:c`)
    ],
    [{ ...Markup.callbackButton(t('coedit.btn.remove'), `ce:rm:${pack._id}:${member.user}`), style: 'danger' }],
    [Markup.callbackButton(t('coedit.btn.back'), `coedit:${pack._id}`)]
  ])
}

const ownerActor = (ctx) => ctx.from

// A new link: the old one stops working, members keep their access.
composer.action(/^coedit:reset:(.+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  pack.passcode = generatePasscode()
  await pack.save()
  coedit.track(ctx.db, pack, ownerActor(ctx), 'reset')
  await ctx.answerCbQuery()
  return renderMenu(ctx, pack, ctx.i18n.t('coedit.reset'))
})

composer.action(/^coedit:(.+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  await ctx.answerCbQuery()
  return renderMenu(ctx, pack)
})

composer.action(/^ce:u:(\w+):(\w+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  const member = findMember(pack, ctx.match[2])
  await ctx.answerCbQuery()
  if (!member) return renderMenu(ctx, pack)
  return renderMember(ctx, pack, member)
})

composer.action(/^ce:r:(\w+):(\w+):(e|c)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  const member = findMember(pack, ctx.match[2])
  if (!member) {
    await ctx.answerCbQuery()
    return renderMenu(ctx, pack)
  }

  const role = ctx.match[3] === 'c' ? 'contributor' : 'editor'
  await ctx.answerCbQuery()
  if (member.role === role) return renderMember(ctx, pack, member)

  await ctx.db.StickerSet.updateOne({ _id: pack._id, 'editors.user': member.user }, { $set: { 'editors.$.role': role } })
  member.role = role
  coedit.track(ctx.db, pack, ownerActor(ctx), 'role', { target: { telegramId: member.telegramId, name: member.name }, role })
  coedit.notify(ctx.db, ctx.telegram, member.user, 'coedit.role_notice', {
    title: escapeHTML(pack.title),
    role: coedit.roleLabel((key) => ctx.i18n.t(key), role)
  })
  return renderMember(ctx, pack, member)
})

composer.action(/^ce:rm:(\w+):(\w+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  const member = findMember(pack, ctx.match[2])
  await ctx.answerCbQuery()
  if (member) {
    await coedit.removeMember(ctx.db, pack, member.user)
    coedit.track(ctx.db, pack, ownerActor(ctx), 'removed', { force: true, target: { telegramId: member.telegramId, name: member.name } })
    coedit.notify(ctx.db, ctx.telegram, member.user, 'coedit.removed_notice', { title: escapeHTML(pack.title) })
  }
  return renderMenu(ctx, await ctx.db.StickerSet.findById(pack._id))
})

composer.action(/^ce:def:(\w+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  const next = (pack.coedit?.defaultRole || coedit.DEFAULT_ROLE) === 'editor' ? 'contributor' : 'editor'
  await ctx.db.StickerSet.updateOne({ _id: pack._id }, { $set: { 'coedit.defaultRole': next } })
  await ctx.answerCbQuery(coedit.roleLabel((key) => ctx.i18n.t(key), next))
  return renderMenu(ctx, await ctx.db.StickerSet.findById(pack._id))
})

// Remove everyone — asks first, and replaces the link so nobody walks back in.
composer.action(/^ce:clear:(\w+)(:y)?$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  await ctx.answerCbQuery()

  if (!ctx.match[2]) {
    return show(ctx, ctx.i18n.t('coedit.clear_confirm', { count: (pack.editors || []).length, title: escapeHTML(pack.title) }), [
      [{ ...Markup.callbackButton(ctx.i18n.t('coedit.btn.clear_confirm'), `ce:clear:${pack._id}:y`), style: 'danger' }],
      [Markup.callbackButton(ctx.i18n.t('coedit.btn.back'), `coedit:${pack._id}`)]
    ])
  }

  const members = pack.editors || []
  pack.editors = []
  pack.passcode = generatePasscode()
  pack.coedit = { ...(pack.coedit?.toObject ? pack.coedit.toObject() : pack.coedit), migrated: true }
  await pack.save()
  await ctx.db.User.updateMany({ stickerSet: pack._id, _id: { $ne: pack.owner } }, { $set: { stickerSet: null } })
  coedit.track(ctx.db, pack, ownerActor(ctx), 'clear', { force: true, count: members.length })
  for (const member of members) {
    coedit.notify(ctx.db, ctx.telegram, member.user, 'coedit.removed_notice', { title: escapeHTML(pack.title) })
  }
  return renderMenu(ctx, pack, ctx.i18n.t('coedit.cleared'))
})

const formatTime = (date) => {
  const iso = new Date(date).toISOString()
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`
}

composer.action(/^ce:log:(\w+):(\d+)$/, async (ctx) => {
  const pack = await loadOwned(ctx, ctx.match[1])
  if (!pack) return
  await ctx.answerCbQuery()

  const t = (key, params) => ctx.i18n.t(key, params)
  const page = parseInt(ctx.match[2], 10) || 0
  const entries = await ctx.db.PackActivity.find({ stickerSet: pack._id })
    .sort({ createdAt: -1 })
    .skip(page * ACTIVITY_PAGE)
    .limit(ACTIVITY_PAGE + 1)
    .lean()

  const hasMore = entries.length > ACTIVITY_PAGE
  if (hasMore) entries.pop()

  const lines = entries.map((entry) => `<code>${formatTime(entry.createdAt)}</code> ${escapeHTML(entry.actor?.name || '?')} — ${t(`coedit.actions.${entry.action}`, {
    count: entry.count || 1,
    target: escapeHTML(entry.target?.name || ''),
    role: entry.role ? coedit.roleLabel(t, entry.role) : ''
  })}`)

  const nav = []
  if (page > 0) nav.push(Markup.callbackButton('‹', `ce:log:${pack._id}:${page - 1}`))
  if (hasMore) nav.push(Markup.callbackButton('›', `ce:log:${pack._id}:${page + 1}`))

  return show(ctx, t('coedit.activity', {
    title: escapeHTML(pack.title),
    link: packLink(pack),
    entries: lines.join('\n') || t('coedit.activity_empty')
  }), [
    ...(nav.length ? [nav] : []),
    [Markup.callbackButton(t('coedit.btn.back'), `coedit:${pack._id}`)]
  ])
})

// A member leaves on their own.
composer.action(/^ce:leave:(\w+)$/, async (ctx) => {
  const pack = await ctx.db.StickerSet.findById(ctx.match[1]).catch(() => null)
  const userId = coedit.idOf(ctx.session.userInfo)
  if (!pack || !findMember(pack, userId)) return ctx.answerCbQuery(ctx.i18n.t('callback.pack.answerCbQuer.not_found'), true)

  await coedit.removeMember(ctx.db, pack, ctx.session.userInfo._id)
  if (coedit.idOf(ctx.session.userInfo.stickerSet) === String(pack._id)) ctx.session.userInfo.stickerSet = null

  coedit.track(ctx.db, pack, ctx.from, 'leave', { force: true })
  coedit.notify(ctx.db, ctx.telegram, pack.owner, 'coedit.left_notice', {
    name: escapeHTML(coedit.displayName(ctx.from)),
    title: escapeHTML(pack.title)
  })

  await ctx.answerCbQuery()
  return ctx.editMessageText(ctx.i18n.t('coedit.left', { title: escapeHTML(pack.title) }), { parse_mode: 'HTML' })
    .catch(() => ctx.replyWithHTML(ctx.i18n.t('coedit.left', { title: escapeHTML(pack.title) })))
})

module.exports = composer
