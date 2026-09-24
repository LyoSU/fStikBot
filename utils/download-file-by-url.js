const http = require('http')
const https = require('https')

const MAX_SIZE = 20 * 1024 * 1024 // 20MB limit

// Download a file into a Buffer. Always settles: `timeout` bounds the whole
// download, not only socket idleness. With just req.setTimeout a response
// trickling a byte at a time never finished, and a connection cut mid-body
// left the promise pending — and the user's add queue blocked behind it.
module.exports = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  let settled = false

  const finish = (error, result) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    if (error) {
      req.destroy()
      reject(error)
    } else {
      resolve(result)
    }
  }

  const deadline = setTimeout(() => finish(new Error('Download timeout')), timeout)

  // A self-hosted Bot API server (apiRoot over http) serves files over http;
  // https.get refused those URLs outright.
  const client = String(fileUrl).startsWith('http:') ? http : https

  const req = client.get(fileUrl, (response) => {
    if (response.statusCode !== 200) {
      response.resume()
      return finish(new Error(`Download failed with status ${response.statusCode}`))
    }

    response.on('data', (chunk) => {
      totalSize += chunk.length
      if (totalSize > MAX_SIZE) return finish(new Error('File too large'))
      data.push(chunk)
    })
    response.on('end', () => {
      // 'end' after a cut connection means a truncated body.
      if (!response.complete) return finish(new Error('Download interrupted'))
      finish(null, Buffer.concat(data))
    })
    response.on('aborted', () => finish(new Error('Download interrupted')))
    response.on('error', (error) => finish(new Error(`Download interrupted: ${error.message}`)))
    response.on('close', () => {
      if (!response.complete) finish(new Error('Download interrupted'))
    })
  })

  req.on('error', (error) => finish(error))
  req.setTimeout(timeout, () => finish(new Error('Download timeout')))
})
