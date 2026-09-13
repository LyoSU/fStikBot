// Collects the messages of one album.
//
// Telegram delivers an album as separate updates that share a media_group_id,
// with no marker for "that was the last one" — the only way to know the album
// is complete is a short quiet period. Only one of the messages (usually the
// first) carries the caption.
//
// The caller gets a promise for the whole album on the FIRST message, so it can
// reserve the album's place in the user's queue right away (anything the user
// sends after the album stays after it) and only start working once the album
// is complete.
const QUIET_MS = parseInt(process.env.MEDIA_GROUP_QUIET_MS, 10) || 1200

const groups = new Map()

/**
 * @param {string} key unique per chat + media_group_id
 * @param {*} item stored as-is
 * @returns {{first: boolean, items: Promise<Array>}} `first` is true for the
 *   message that opened the album — only that caller should act on `items`
 */
function collect (key, item) {
  let group = groups.get(key)
  const first = !group

  if (first) {
    group = { items: [], timer: null }
    group.done = new Promise((resolve) => { group.resolve = resolve })
    groups.set(key, group)
  }

  group.items.push(item)
  clearTimeout(group.timer)
  group.timer = setTimeout(() => {
    groups.delete(key)
    group.resolve(group.items)
  }, QUIET_MS)

  return { first, items: group.done }
}

module.exports = { collect, QUIET_MS }
