// Co-editing: who else may work on a pack, and what they may do.
//
//   owner        everything
//   editor       add, delete and restore stickers, change emoji, pack settings
//   contributor  add stickers; change the emoji of the sticker they just added
//   public       the shared demo pack (passcode "public"): add, delete, emoji
//
// People join through the pack's co-edit link (/start s_<passcode>) with the
// pack's default role; the owner changes roles or removes members in the
// co-edit menu (handlers/coedit.js). Before the member list existed, having
// the pack selected through the link was the only grant — such users become
// editors the first time they act, or when the owner opens the menu.
const path = require('path')
const I18n = require('telegraf-i18n')
const log = require('./logger').scope('coedit')

const ROLES = ['editor', 'contributor']
const DEFAULT_ROLE = 'editor'

const PERMISSIONS = {
  owner: ['add', 'delete', 'emoji', 'settings'],
  editor: ['add', 'delete', 'emoji', 'settings'],
  contributor: ['add'],
  public: ['add', 'delete', 'emoji']
}

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const idOf = (value) => String(value?._id || value || '')

// Mongoose 5 reports nModified, 6+ modifiedCount.
const modified = (result) => (result?.modifiedCount ?? result?.nModified ?? 0) > 0

// Stored as plain text; escape when rendering.
const displayName = (user) => {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    (user?.username ? `@${user.username}` : String(user?.id || user?.telegramId || '?'))
  return name.slice(0, 64)
}

const can = (access, action) => !!access && PERMISSIONS[access.role].includes(action)

const loadPack = (db, pack) => db.StickerSet.findById(idOf(pack))
  .select('owner ownerTelegramId name title packType passcode editors coedit deleted')
  .lean()

async function addMember (db, pack, telegramUser, userId, role) {
  const result = await db.StickerSet.updateOne(
    { _id: idOf(pack), 'editors.user': { $ne: userId } },
    {
      $push: {
        editors: {
          user: userId,
          telegramId: telegramUser.id,
          name: displayName(telegramUser),
          role: ROLES.includes(role) ? role : DEFAULT_ROLE,
          addedAt: new Date()
        }
      }
    }
  )
  return modified(result)
}

async function removeMember (db, pack, userId) {
  const result = await db.StickerSet.updateOne({ _id: idOf(pack) }, { $pull: { editors: { user: userId } } })
  // A removed member's next add re-checks access and finds nothing; this
  // just stops the pack from staying selected in their saved profile. The
  // inline pack is read without an access check, so it is dropped too.
  await Promise.all([
    db.User.updateOne({ _id: userId, stickerSet: idOf(pack) }, { $set: { stickerSet: null } }),
    db.User.updateOne({ _id: userId, inlineStickerSet: idOf(pack) }, { $set: { inlineStickerSet: null } })
  ])
  return modified(result)
}

/**
 * The current user's access to a pack.
 *
 * @param {Object} ctx
 * @param {Object} pack a StickerSet (document, lean object or populated ref)
 * @returns {Promise<{role: 'owner'|'editor'|'contributor'|'public', member?: Object}|null>}
 */
async function getAccess (ctx, pack) {
  if (!pack) return null
  const userId = idOf(ctx.session.userInfo)

  if (pack.owner && idOf(pack.owner) === userId) return { role: 'owner' }
  if (pack.passcode === 'public') return { role: 'public' }

  const full = Array.isArray(pack.editors) && pack.owner ? pack : await loadPack(ctx.db, pack)
  if (!full || full.deleted) return null
  if (idOf(full.owner) === userId) return { role: 'owner' }
  if (full.passcode === 'public') return { role: 'public' }

  const member = (full.editors || []).find((entry) => idOf(entry.user) === userId)
  if (member) return { role: member.role || DEFAULT_ROLE, member }

  if (!full.coedit?.migrated && idOf(ctx.session.userInfo?.stickerSet) === idOf(full)) {
    await addMember(ctx.db, full, ctx.from, ctx.session.userInfo._id, DEFAULT_ROLE)
    return { role: DEFAULT_ROLE }
  }

  return null
}

// Adds by the same person within this window are one log entry with a count.
const ADD_MERGE_MS = 10 * 60 * 1000

/**
 * Record an action in a shared pack's activity log. Packs without co-editors
 * are not logged unless `force` (for the last member leaving).
 */
async function logActivity (db, pack, actor, action, { force = false, ...extra } = {}) {
  const packId = idOf(pack)
  if (!force && !await db.StickerSet.exists({ _id: packId, 'editors.0': { $exists: true } })) return

  const telegramId = actor?.id ?? actor?.telegramId

  if (action === 'add') {
    const merged = await db.PackActivity.updateOne({
      stickerSet: packId,
      action: 'add',
      'actor.telegramId': telegramId,
      createdAt: { $gte: new Date(Date.now() - ADD_MERGE_MS) }
    }, { $inc: { count: extra.count || 1 } })
    if (modified(merged)) return
  }

  await db.PackActivity.create({
    stickerSet: packId,
    actor: { telegramId, name: actor?.name || displayName(actor) },
    action,
    ...extra
  })
}

// Fire-and-forget: a failed log write must never fail the action itself.
const track = (...args) => {
  logActivity(...args).catch((err) => log.warn('activity log failed:', err.message))
}

// A message to another user, in their own language.
async function notify (db, telegram, userRef, key, params) {
  const query = typeof userRef === 'number' ? { telegram_id: userRef } : { _id: idOf(userRef) }
  const user = await db.User.findOne(query).select('telegram_id locale blocked').lean().catch(() => null)
  if (!user || user.blocked) return

  await telegram.sendMessage(user.telegram_id, i18n.t(user.locale || 'en', key, params), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }).catch(() => {})
}

const roleLabel = (t, role) => t(`coedit.roles.${ROLES.includes(role) ? role : DEFAULT_ROLE}`)

module.exports = {
  ROLES,
  DEFAULT_ROLE,
  can,
  getAccess,
  addMember,
  removeMember,
  logActivity,
  track,
  notify,
  roleLabel,
  displayName,
  modified,
  idOf
}
