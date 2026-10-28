// Short names for new packs, shared by the /new wizard (scenes/pack-new.js)
// and Studio's create phase, so both make the same names the same way.

const crypto = require('crypto')
const slug = require('limax')

// A pack's short name: Latin letters, digits and "_", starting with a letter.
const normalizeName = (raw) => {
  const name = slug(
    String(raw || '')
      .replace(/https?:\/\//, '')
      .replace(/t\.me\/add(stickers|emoji)\//, ''),
    { separator: '_', maintainCase: true }
  )
  return name
    .replace(/[^0-9a-z_]/gi, '')
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-z]+/i, '')
    .replace(/_+$/, '')
}

const fitName = (name, suffix) => name.slice(0, 64 - suffix.length).replace(/_+$/, '')

// Names to try for a pack the user didn't name: the title itself, then the
// title with a short random tail. The "type a Latin link" step was where most
// people gave up on /new — a custom link is now an optional button.
const autoNameCandidates = (title, suffix) => {
  const base = fitName(normalizeName(title) || 'stickers', suffix + '_xxxx')
  const tail = () => crypto.randomBytes(2).toString('hex')
  return [base, `${base}_${tail()}`, `${base}_${tail()}`].map((name) => name + suffix)
}

// The one name a user-chosen link allows; null when nothing usable is left.
const customNameCandidates = (raw, suffix) => {
  const name = fitName(normalizeName(raw), suffix)
  return name ? [name + suffix] : null
}

// A restored pack asks for the name it had (already with the bot's suffix) and
// falls back to a name made from the title, like any new pack. The old name is
// only offered when it is still a valid one for this bot.
const restoreNameCandidates = (oldName, title, suffix) => {
  const valid = typeof oldName === 'string' && oldName.length <= 64 && oldName.endsWith(suffix) &&
    /^[a-z](?:[a-z0-9]|_(?!_))*$/i.test(oldName)
  return [...(valid ? [oldName] : []), ...autoNameCandidates(title, suffix)]
}

// SHORTNAME_OCCUPY_FAILED: Telegram could not register the name; another
// one may go through.
const NAME_REJECTED = /STICKERSET_INVALID|name is already occupied|invalid sticker set name|SHORTNAME_OCCUPY_FAILED/i

module.exports = { normalizeName, fitName, autoNameCandidates, customNameCandidates, restoreNameCandidates, NAME_REJECTED }
