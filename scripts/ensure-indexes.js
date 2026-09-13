// Create the indexes the schemas declare. autoIndex is off in the app (index
// builds are an ops decision, not a boot side effect), so new indexes — the
// pending-payment TTL, the co-edit activity log TTL, broadcast recipient
// uniqueness, shared-pack lookups — only exist once this has run.
//
//   node scripts/ensure-indexes.js --dry-run   # list what's missing
//   node scripts/ensure-indexes.js             # create the missing ones
//
// Never drops or modifies an existing index: mongoose's diffIndexes() also
// lists indexes to drop (anything created by hand), and those are ignored.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { db } = require('../database')

const dryRun = process.argv.includes('--dry-run')

const models = () => Object.keys(db)
  .filter((name) => db[name] && typeof db[name].diffIndexes === 'function')
  .map((name) => [name, db[name]])

async function run () {
  await db.connection.asPromise()
  let missing = 0

  for (const [name, model] of models()) {
    const { toCreate } = await model.diffIndexes()
    const declared = model.schema.indexes()

    for (const key of toCreate) {
      const [, options = {}] = declared.find(([fields]) => JSON.stringify(fields) === JSON.stringify(key)) || []
      missing++
      console.log(`  + ${name} ${JSON.stringify(key)} ${JSON.stringify(options)}`)
      if (!dryRun) await model.collection.createIndex(key, options)
    }
  }

  console.log(missing === 0 ? 'all declared indexes exist' : `${missing} index(es) ${dryRun ? 'missing' : 'created'}`)
}

run()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.connection.close().catch(() => {})
    // Model modules keep timers alive; this is a one-shot CLI.
    process.exit()
  })
