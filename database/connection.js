const mongoose = require('mongoose')
const log = require('../utils/logger').scope('mongo')

// mongodb+srv:// URIs resolve their own hosts; directConnection only makes
// sense for a plain single-host mongodb:// URI.
const isSrvUri = (uri) => uri && uri.startsWith('mongodb+srv://')

// Pool sized for burst recovery: after a PM2 restart with ~300 pending
// updates, the bot processes them concurrently. Each update does ~4 Mongo
// ops (updateUser: findOne + 2 populates + user.save). With pool=10 that
// queued 120+ deep per connection, forcing each query to wait ~600-1300ms.
// Pool=50 keeps the burst queue ≤20 deep so each query waits <100ms.
// Memory cost is trivial (~1MB per connection client-side).
//
// useUnifiedTopology: Mongoose 5 still defaults to the legacy SDAM engine,
// which logs a deprecation warning at boot and ignores serverSelectionTimeoutMS,
// directConnection and minPoolSize. useFindAndModify:false makes
// findOneAndUpdate use the native command instead of the deprecated
// findAndModify.
//
// autoIndex:false — index management is an ops task, not a boot-time side
// effect; see scripts/README.md.
const mainUri = process.env.MONGODB_URI
const connection = mongoose.createConnection(mainUri, {
  ...(isSrvUri(mainUri) ? {} : { directConnection: true }),
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  autoIndex: false,
  maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || 50,
  minPoolSize: parseInt(process.env.MONGO_POOL_MIN, 10) || 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 30000,
  retryWrites: true,
  retryReads: true
})

connection.on('error', (error) => log.error('connection error:', error))
connection.on('disconnected', () => log.warn('disconnected'))
connection.on('reconnected', () => log.info('reconnected'))

module.exports = {
  connection
}
