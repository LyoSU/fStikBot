// The pack menu — one renderer for every place a pack is opened: /packs, a
// co-edit link, a freshly created pack, and the screens that return to it
// (boost, hide/restore, catalog). There used to be three hand-built menus that
// disagreed on which buttons a pack had.
const StegCloak = require('stegcloak')
const Markup = require('telegraf/markup')
const escapeHTML = require('../utils/html-escape')
const packLink = require('../utils/pack-link')

const stegcloak = new StegCloak(false, false)

// Catalog publishing is offered once a pack has something to show.
const CATALOG_MIN_STICKERS = 10

const isOwner = (ctx, stickerSet) => String(stickerSet.owner) === String(ctx.session.userInfo.id)

const rows = (buttons, perRow = 2) => {
  const out = []
  const flat = buttons.filter(Boolean)
  for (let i = 0; i < flat.length; i += perRow) out.push(flat.slice(i, i + perRow))
  return out
}

const catalogRows = async (ctx, stickerSet) => {
  const t = (key) => ctx.i18n.t(key)
  const bot = ctx.options.username

  if (stickerSet.public) {
    return [
      [
        Markup.callbackButton(t('callback.pack.btn.catalog_edit'), `catalog:publish:${stickerSet.id}`),
        Markup.callbackButton(t('callback.pack.btn.catalog_delete'), `catalog:unpublish:${stickerSet.id}`)
      ],
      [
        Markup.urlButton(t('callback.pack.btn.catalog_share'), `https://t.me/share/url?url=https://t.me/${bot}/catalog?startapp=set=${stickerSet.name}`),
        Markup.urlButton(t('callback.pack.btn.catalog_open'), `https://t.me/${bot}/catalog?startApp=set=${stickerSet.name}&startapp=set=${stickerSet.name}`)
      ]
    ]
  }

  const count = await ctx.db.Sticker.countDocuments({ stickerSet: stickerSet._id, deleted: false })
  if (count < CATALOG_MIN_STICKERS) return []
  return [[Markup.callbackButton(t('callback.pack.btn.catalog_add'), `catalog:publish:${stickerSet.id}`)]]
}

/**
 * Text and keyboard for a pack's menu.
 *
 * @param {Object} ctx
 * @param {Object} stickerSet StickerSet document
 * @param {Object} [options]
 * @param {string} [options.notice] HTML line shown above the menu (e.g. boost result)
 * @param {string} [options.text] HTML replacing the menu's own text (e.g. "pack created")
 * @returns {Promise<{text: string, extra: Object}>}
 */
async function buildPackMenu (ctx, stickerSet, { notice, text: textOverride } = {}) {
  const t = (key, params) => ctx.i18n.t(key, params)
  const owner = isOwner(ctx, stickerSet)
  const hidden = stickerSet.hide === true
  const title = escapeHTML(stickerSet.title)

  let text
  const keyboard = []

  if (hidden) {
    text = t('callback.pack.hidden', { title, link: packLink(stickerSet) })
  } else if (stickerSet.inline) {
    text = t('callback.pack.set_inline_pack', { title, botUsername: ctx.options.username })
  } else {
    text = t('callback.pack.set_pack', { title, link: packLink(stickerSet) })
    if (owner) {
      text += t('callback.pack.boost.info', {
        botUsername: ctx.options.username,
        boostStatus: t(stickerSet.boost ? 'callback.pack.boost.status.on' : 'callback.pack.boost.status.off')
      })
    }
  }

  if (textOverride) text = textOverride
  if (notice) text = `${notice}\n\n${text}`

  keyboard.push([stickerSet.inline
    ? Markup.switchToChatButton(t('callback.pack.btn.use_pack'), '')
    : Markup.urlButton(t('callback.pack.btn.use_pack'), `https://${packLink(stickerSet)}`)
  ])

  if (owner && hidden) {
    keyboard.push([
      { ...Markup.callbackButton(t('callback.pack.btn.restore'), `hide_pack:${stickerSet.id}`), style: 'success' },
      { ...Markup.callbackButton(t('callback.pack.btn.delete'), `delete_pack:${stickerSet.id}`), style: 'danger' }
    ])
  } else if (owner && stickerSet.inline) {
    keyboard.push([Markup.callbackButton(t('callback.pack.btn.hide'), `hide_pack:${stickerSet.id}`)])
  } else if (owner) {
    // The GIF search opens inline mode; for a user whose inline mode is set to
    // their packs, the hidden marker switches that one query to GIFs.
    const gifQuery = ctx.session.userInfo.inlineType === 'packs' ? stegcloak.hide('{gif}', '', ' : ') : ''

    keyboard.push(...rows([
      !stickerSet.boost && Markup.callbackButton(t('callback.pack.btn.boost'), `boost:${stickerSet.id}`),
      Markup.callbackButton(t('callback.pack.btn.rename'), `rename_pack:${stickerSet.id}`),
      Markup.callbackButton(t('callback.pack.btn.frame'), 'set_frame'),
      stickerSet.packType === 'custom_emoji'
        ? Markup.callbackButton(t('callback.pack.btn.mosaic'), 'mosaic:enter')
        : Markup.switchToCurrentChatButton(t('callback.pack.btn.search_gif'), gifQuery),
      Markup.callbackButton(t('callback.pack.btn.coedit'), `coedit:${stickerSet.id}`)
    ]))
    keyboard.push(...await catalogRows(ctx, stickerSet))
    keyboard.push([Markup.callbackButton(t('callback.pack.btn.hide'), `hide_pack:${stickerSet.id}`)])
  } else if (!stickerSet.inline && stickerSet.passcode !== 'public') {
    // Co-editors may change the frame (see scenes/pack-frame.js); the shared
    // public demo pack may not.
    keyboard.push([Markup.callbackButton(t('callback.pack.btn.frame'), 'set_frame')])
  }

  return {
    text,
    extra: {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard(keyboard)
    }
  }
}

async function sendPackMenu (ctx, stickerSet, options) {
  const { text, extra } = await buildPackMenu(ctx, stickerSet, options)
  return ctx.replyWithHTML(text, extra)
}

// Re-render the menu in the message the button was pressed on. Falls back to a
// new message when that one can't be edited (too old, or it's a banner photo).
async function editPackMenu (ctx, stickerSet, options) {
  const { text, extra } = await buildPackMenu(ctx, stickerSet, options)
  try {
    await ctx.editMessageText(text, extra)
  } catch (err) {
    if (/message is not modified/i.test(err.description || err.message || '')) return
    await ctx.replyWithHTML(text, extra)
  }
}

module.exports = { buildPackMenu, sendPackMenu, editPackMenu, isOwner }
