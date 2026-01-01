const mongoose = require('mongoose')

// Визначаємо чи це SRV URI (mongodb+srv://)
const isSrvUri = (uri) => uri && uri.startsWith('mongodb+srv://')

// Основне з'єднання
const mainUri = process.env.MONGODB_URI
const connection = mongoose.createConnection(mainUri, {
  // directConnection тільки для звичайних URI, не для SRV
  ...(isSrvUri(mainUri) ? {} : { directConnection: true }),
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  retryReads: true
})

connection.on('error', error => {
  console.error('MongoDB connection error:', error)
})

connection.on('disconnected', () => {
  console.warn('MongoDB disconnected, attempting to reconnect...')
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
  maxIdleTimeMS: 60000,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true
})

atlasConnection.on('error', error => {
  console.error('Atlas MongoDB connection error:', error)
})

module.exports = {
  connection,
  atlasConnection
}
