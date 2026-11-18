// The worker saves a commit with replaceOne (pack-ops/store.js), and the
// PackCommit schema is strict: a field the executor sets but the schema does
// not list is dropped on every save, silently. That lost a resumed publish's
// recovery state until 2026-11-18. This test finds every `commit.<field> =`
// in pack-ops/ and checks the schema keeps it.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const schema = require('../database/models/pack-commit')

const dir = path.join(__dirname, '..', 'pack-ops')
const assigned = new Set()
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8')
  for (const [, field] of source.matchAll(/\bcommit\.([a-zA-Z]+)\s*=[^=]/g)) assigned.add(field)
}
assert.ok(assigned.size > 10, `found only ${assigned.size} assignments: the pattern broke`)

const missing = [...assigned].filter((field) => !schema.path(field))
assert.deepStrictEqual(missing, [], `PackCommit drops these on save: ${missing.join(', ')}`)

console.log(`pack-commit schema test OK (${assigned.size} fields)`)
