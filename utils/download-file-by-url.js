const http = require('http')
const https = require('https')

module.exports = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  const MAX_SIZE = 20 * 1024 * 1024 // 20MB limit

  // A self-hosted Bot API server (apiRoot over http) serves files over http;
  // https.get refused those URLs outright.
  const client = String(fileUrl).startsWith('http:') ? http : https

  const req = client.get(fileUrl, (response) => {
    // Check for successful response status
    if (response.statusCode !== 200) {
      req.destroy()
      reject(new Error(`Download failed with status ${response.statusCode}`))
      return
    }

    response.on('data', (chunk) => {
      totalSize += chunk.length
      if (totalSize > MAX_SIZE) {
        req.destroy()
        reject(new Error('File too large'))
        return
      }
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(Buffer.concat(data))
    })
  })

  req.on('error', reject)

  req.setTimeout(timeout, () => {
    req.destroy()
    reject(new Error('Download timeout'))
  })
})
