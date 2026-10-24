// The title a pack gets from Studio, formed like the bot's own rename
// (scenes/pack-rename.js): cut to the limit of the pack's tier, and for a pack
// without Boost followed by the bot's name.

const countUncodeChars = require('../utils/unicode-chars-count')
const substrUnicode = require('../utils/unicode-substr')

/**
 * The bot's username, asked once.
 * @param {{getMe: Function}} telegram
 * @returns {() => Promise<string>}
 */
function createUsernameGetter (telegram) {
  let username = null
  return async () => {
    username = username || (await telegram.getMe()).username
    return username
  }
}

/**
 * @param {{getMe: Function}} telegram
 * @param {{charTitleMax: number, premiumCharTitleMax: number}} config
 * @param {() => Promise<string>} [getUsername]
 * @returns {(commit: Object, title: string) => Promise<string>}
 */
function createTitleFormatter (telegram, config, getUsername = createUsernameGetter(telegram)) {
  return async (commit, title) => {
    const max = commit.boost ? config.premiumCharTitleMax : config.charTitleMax
    const cut = countUncodeChars(title) > max ? substrUnicode(title, 0, max) : title
    if (commit.boost) return cut

    return `${cut} :: @${await getUsername()}`
  }
}

module.exports = { createTitleFormatter, createUsernameGetter }
