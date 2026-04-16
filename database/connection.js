const mongoose = require('mongoose')

// Визначаємо чи це SRV URI (mongodb+srv://)
const isSrvUri = (uri) => uri && uri.startsWith('mongodb+srv://')

// Основне з'єднання.
// Pool sized for burst recovery: after a PM2 restart with ~300 pending
// updates, the bot processes them concurrently. Each update does ~4 Mongo
// ops (updateUser: findOne + 2 populates + user.save). With pool=10 that
// queued 120+ deep per connection, forcing each query to wait ~600-1300ms.
// Pool=50 keeps the burst queue ≤20 deep so each query waits <100ms.
// Memory cost is trivial (~1MB per connection client-side).
const mainUri = process.env.MONGODB_URI
const connection = mongoose.createConnection(mainUri, {
  ...(isSrvUri(mainUri) ? {} : { directConnection: true }),
  autoIndex: false,
  maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || 50,
  minPoolSize: parseInt(process.env.MONGO_POOL_MIN, 10) || 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 30000,
  retryWrites: true,
  retryReads: true
})

connection.on('error', error => {
  console.error('MongoDB connection error:', error)
})

connection.on('disconnected', () => {
  console.warn('MongoDB disconnected')
})

connection.on('reconnected', () => {
  console.log('MongoDB reconnected')
})

// Atlas з'єднання (для аналітики/top-sets)
const atlasUri = process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI
const atlasConnection = mongoose.createConnection(atlasUri, {
  ...(isSrvUri(atlasUri) ? {} : { directConnection: true }),
  maxPoolSize: 5,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 30000,
  retryWrites: true,
  retryReads: true
})

atlasConnection.on('error', error => {
  console.error('Atlas MongoDB error:', error)
})

module.exports = {
  connection,
  atlasConnection
}
