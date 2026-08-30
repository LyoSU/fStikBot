// Guards against `ctx.i18n.t('some.key')` where `some.key` doesn't exist.
//
// telegraf-i18n runs with allowMissing, so a missing key is not an error — it
// is rendered to the user verbatim, e.g. the message "scenes.frame.no_sticker_set".
// This walks every i18n.t('literal') in the source and checks it against en.yaml
// (the fallback locale, so en is what actually has to be complete).
//
// It also reports keys that exist in en but are missing from uk/ru as a warning,
// without failing — en is a valid fallback for the other locales.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const SOURCE_DIRS = ['handlers', 'scenes', 'utils', 'bot', 'broadcast', 'banners']
const PRIMARY_LOCALES = ['en', 'uk', 'ru']

function flatten (obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    out.add(key)
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
  }
  return out
}

function loadLocale (name) {
  // safeLoad: js-yaml 3's load() honours custom type tags; the locale files are
  // plain data and there is no reason to allow anything else.
  return flatten(yaml.safeLoad(fs.readFileSync(path.join(ROOT, 'locales', `${name}.yaml`), 'utf8')))
}

function jsFiles (dir) {
  const out = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.js')) out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

// Matches `i18n.t('key')`, `i18n.t(lang, 'key')`, `i18n.t('ru', 'key')` and
// `i18n.t(input.locale || 'en', 'key')`. The optional first group swallows a
// locale argument, including a short quoted locale literal. Template literals
// and computed keys are skipped on purpose — only literals can be checked
// statically.
const T_CALL = /\bi18n\.t\(\s*(?:[^,'"()]*(?:'[a-zA-Z-]{2,5}'[^,'"()]*)?\s*,\s*)?'([^'${}\n]+)'/g

function main () {
  const files = SOURCE_DIRS.flatMap((d) => jsFiles(path.join(ROOT, d)))
  const used = new Map()

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(T_CALL)) {
      const key = m[1]
      if (!used.has(key)) used.set(key, new Set())
      used.get(key).add(path.relative(ROOT, file))
    }
  }

  const en = loadLocale('en')
  const missing = [...used.keys()].filter((k) => !en.has(k)).sort()

  console.log(`\nchecked ${used.size} i18n keys across ${files.length} files\n`)

  for (const key of missing) {
    console.log(`  MISSING in en.yaml  ${key}  ←  ${[...used.get(key)].join(', ')}`)
  }

  for (const locale of PRIMARY_LOCALES.filter((l) => l !== 'en')) {
    const keys = loadLocale(locale)
    const gaps = [...used.keys()].filter((k) => en.has(k) && !keys.has(k))
    if (gaps.length) {
      console.log(`  note: ${gaps.length} key(s) fall back to en in ${locale}.yaml: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? ' …' : ''}`)
    }
  }

  // The keys added for the audit fixes — pinned so they can't silently vanish
  // from any of the three primary locales.
  const REQUIRED = [
    'scenes.search.error.not_found',
    'scenes.frame.no_sticker_set',
    'error.stickerset_invalid',
    'scenes.boost.error.too_fast',
    'scenes.error.notFound',
    'cmd.emoji.no_pack_selected',
    'scenes.new_pack.error.inline_exists'
  ]

  let failed = 0
  for (const locale of PRIMARY_LOCALES) {
    const keys = loadLocale(locale)
    for (const key of REQUIRED) {
      try {
        assert.ok(keys.has(key), `${key} missing from ${locale}.yaml`)
      } catch (err) {
        failed++
        console.log(`  FAIL  ${err.message}`)
      }
    }
  }

  if (missing.length || failed) {
    console.log(`\n${missing.length} missing key(s), ${failed} required-key failure(s)`)
    process.exit(1)
  }

  console.log('i18n keys OK: every i18n.t() literal resolves in en.yaml')
}

main()
