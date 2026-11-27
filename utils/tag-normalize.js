// Pack tags as they are written (spec v1). The same file lives in fStikBot
// (utils/tag-normalize.js, which writes `about.tags`) and fstikbot-api
// (utils/tag-normalize.js), with the same test vectors
// (tag-normalize.fixtures.json) and the same short-tag dictionary
// (tag-short-keys.json) next to it: change all copies together and bump
// SPEC_VERSION, or the bot and the API compute different keys.
//
// A pack keeps its author's spelling in `about.tags`, only cleaned up: the
// edges trimmed ('#', emoji, punctuation, spaces), duplicates dropped, at most
// MAX_TAGS kept in the author's order. Duplicates are judged on the
// normalized form (normalizeTag): "Cat", "#cat" and "CAT!" are one tag.
//
// `about.tagKeys` holds one key per distinct tag (tagKey): the normalized
// form in Latin letters, so "аниме", "Anime" and "#anime" meet on "anime".
// A tag shorter than SHORT_TAG letters is not transliterated, as short words
// collide across scripts ("кис"/"kys", "jk"/"jjk"); it meets its other
// spelling only through the dictionary (tag-short-keys.json).
const SHORT_KEYS = require('./tag-short-keys.json')

const SPEC_VERSION = 1
const MAX_TAGS = 20
// What the bot asks for; MAX_TAGS is what it keeps.
const SUGGESTED_TAGS = 10
// Longer than this is a sentence pasted as a tag: dropped.
const MAX_TAG_LENGTH = 64
const SHORT_TAG = 5

// Enclosed Latin letters NFKC leaves alone (🄰 🅐 🅰): to their letter.
const ENCLOSED = [0x1F130, 0x1F150, 0x1F170]
const unenclose = (text) => text.replace(/[\u{1F130}-\u{1F189}]/gu, (char) => {
  const code = char.codePointAt(0)
  const base = ENCLOSED.findLast((start) => code >= start)
  return code - base < 26 ? String.fromCharCode(97 + code - base) : char
})

// Look-alike letters, for a word typed in two scripts ("cutе" with a Cyrillic е).
const CYR_LOOKALIKES = 'аеорсухік'
const LAT_LOOKALIKES = 'aeopcyxik'
const CYR_TO_LAT = Object.fromEntries([...CYR_LOOKALIKES].map((char, i) => [char, LAT_LOOKALIKES[i]]))
const LAT_TO_CYR = Object.fromEntries([...LAT_LOOKALIKES].map((char, i) => [char, CYR_LOOKALIKES[i]]))
const LATIN = /[a-z]/g
const CYRILLIC = /[а-яіїєґ]/g

// A word with letters of both scripts is spelled in the one most of its
// letters are: the other script's look-alikes are swapped for its own.
function unmix (word) {
  const latin = (word.match(LATIN) || []).length
  const cyrillic = (word.match(CYRILLIC) || []).length
  if (!latin || !cyrillic) return word
  const map = latin >= cyrillic ? CYR_TO_LAT : LAT_TO_CYR
  return [...word].map((char) => map[char] || char).join('')
}

/**
 * The form two tags are compared in: case and width folded (NFKC), accents
 * off Latin letters (é → e, while й and ї stay), ё → е, every character that
 * is not a letter, digit or mark a space ('#', emoji, punctuation, '_'),
 * mixed-script words in one script, spaces collapsed.
 *
 * @param {unknown} raw
 * @returns {string|null} null when nothing is left
 */
function normalizeTag (raw) {
  if (typeof raw !== 'string') return null
  const text = unenclose(raw)
    .replace(/\p{Cf}+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
  if (!text) return null
  return text.split(' ').map(unmix).join(' ')
}

// Cyrillic (Russian, Ukrainian, Belarusian) in Latin letters, then the
// spellings Latin-script authors vary on folded: kh/h, y/j/i, w/v, x/ks,
// ck/k, and a doubled letter in a word of 5+ letters ("kitty"/"kity").
const CYR = Object.fromEntries(
  ('а:a б:b в:v г:g ґ:g д:d е:e є:e э:e ж:zh з:z и:i і:i ї:i й:i ы:i к:k л:l м:m н:n о:o п:p ' +
  'р:r с:s т:t у:u ў:u ф:f х:h ц:ts ч:ch ш:sh щ:sh ъ: ь: ю:iu я:ia').split(' ').map((pair) => pair.split(':'))
)
const fold = (word) => {
  const latin = [...word].map((char) => CYR[char] ?? char).join('')
    .replace(/kh/g, 'h').replace(/[yj]/g, 'i').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/ck/g, 'k')
  return latin.length >= SHORT_TAG ? latin.replace(/(\p{L})\1+/gu, '$1') : latin
}

const SHORT = new Map()
for (const [key, forms] of Object.entries(SHORT_KEYS.keys)) {
  for (const form of forms) SHORT.set(form, key)
}
const letters = (text) => [...text.replace(/ /g, '')].length

/**
 * The key a tag is grouped and searched by.
 *
 * @param {unknown} raw a tag as written (or a search word)
 * @returns {string|null}
 */
function tagKey (raw) {
  const normalized = normalizeTag(raw)
  if (!normalized) return null
  if (letters(normalized) < SHORT_TAG) return SHORT.get(normalized) || normalized
  return normalized.split(' ').map(fold).filter(Boolean).join(' ') || normalized
}

// The tag as its author wrote it, minus what surrounds it: invisible
// characters, '#', emoji and punctuation at either end, runs of spaces.
function cleanTag (raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\p{Cf}+/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}\p{M}]+$/u, '')
}

/**
 * A pack's tags as stored: the author's spelling cleaned, one per normalized
 * form, the first `max` in order; and the distinct keys of those tags.
 *
 * @param {unknown} list
 * @param {{ max?: number }} [options]
 * @returns {{ tags: string[], tagKeys: string[] }}
 */
function normalizeTags (list, { max = MAX_TAGS } = {}) {
  const tags = []
  const tagKeys = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (tags.length >= max) break
    const tag = cleanTag(raw)
    if (!tag || [...tag].length > MAX_TAG_LENGTH) continue
    const normalized = normalizeTag(tag)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    tags.push(tag)
    const key = tagKey(tag)
    if (key && !tagKeys.includes(key)) tagKeys.push(key)
  }
  return { tags, tagKeys }
}

module.exports = {
  SPEC_VERSION,
  MAX_TAGS,
  SUGGESTED_TAGS,
  MAX_TAG_LENGTH,
  SHORT_TAG,
  normalizeTag,
  tagKey,
  cleanTag,
  normalizeTags
}
