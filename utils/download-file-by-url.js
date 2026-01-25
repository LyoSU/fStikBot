const https = require('https')

module.exports = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  const MAX_SIZE = 20 * 1024 * 1024 // 20MB limit

  const req = https.get(fileUrl, (response) => {
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
