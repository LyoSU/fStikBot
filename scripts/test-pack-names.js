// Unit tests for pack-ops/names.js: the short names a new pack gets.

const assert = require('assert')
const { normalizeName, fitName, autoNameCandidates, customNameCandidates, restoreNameCandidates } = require('../pack-ops/names')

const suffix = '_by_fStikBot'

assert.strictEqual(normalizeName('My Cats!'), 'My_Cats')
assert.strictEqual(normalizeName('https://t.me/addstickers/cool_pack'), 'cool_pack')
assert.strictEqual(normalizeName('123 start'), 'start')
assert.strictEqual(normalizeName('!!!'), '')
assert.strictEqual(normalizeName('Коти'), 'Koti')

assert.ok(fitName('a'.repeat(100), suffix).length + suffix.length <= 64)
assert.ok(!fitName('abc_' + 'x'.repeat(100), suffix).endsWith('_'))

const auto = autoNameCandidates('My Cats', suffix)
assert.strictEqual(auto.length, 3)
assert.strictEqual(auto[0], `My_Cats${suffix}`)
assert.ok(auto.slice(1).every((name) => /^My_Cats_[0-9a-f]{4}_by_fStikBot$/.test(name)))
assert.strictEqual(autoNameCandidates('???', suffix)[0], `stickers${suffix}`)
assert.ok(autoNameCandidates('x'.repeat(100), suffix).every((name) => name.length <= 64))

assert.deepStrictEqual(customNameCandidates('my_link', suffix), [`my_link${suffix}`])
assert.strictEqual(customNameCandidates('!!!', suffix), null)

const restored = restoreNameCandidates(`Old_Cats${suffix}`, 'My Cats', suffix)
assert.strictEqual(restored.length, 4)
assert.strictEqual(restored[0], `Old_Cats${suffix}`, 'the old name first')
assert.strictEqual(restored[1], `My_Cats${suffix}`, 'then the title\'s')
assert.strictEqual(restoreNameCandidates('Old_Cats_by_other', 'My Cats', suffix).length, 3, 'another bot\'s suffix')
assert.strictEqual(restoreNameCandidates('Old__Cats' + suffix, 'My Cats', suffix).length, 3, 'a name Telegram would refuse')
assert.strictEqual(restoreNameCandidates(undefined, 'My Cats', suffix).length, 3)

console.log('pack names test OK')
