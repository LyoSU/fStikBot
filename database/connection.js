const mongoose = require('mongoose')

// Визначаємо чи це SRV URI (mongodb+srv://)
const isSrvUri = (uri) => uri && uri.startsWith('mongodb+srv://')

// Основне з'єднання
const mainUri = process.env.MONGODB_URI
const connection = mongoose.createConnection(mainUri, {
  ...(isSrvUri(mainUri) ? {} : { directConnection: true }),
  maxPoolSize: 10,
  minPoolSize: 2,
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
