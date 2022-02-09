require('dotenv').config({ path: './.env' })
const os = require('os')
const fs = require('fs').promises
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const Queue = require('bull')

const numOfCpus = os.cpus().length

const convertQueue = new Queue('convert', {
  redis: { port: process.env.REDIS_PORT, host: process.env.REDIS_HOST, password: process.env.REDIS_PASSWORD }
})

setInterval(() => {
  convertQueue.clean(5000)
}, 1000 * 5)

convertQueue.process(numOfCpus, async (job, done) => {
  console.time(`📹 job convert #${job.id}`)
  const file = await convertToWebmSticker(job.data.fileUrl).catch(done)

  const content = await fs.readFile(file.output, { encoding: 'base64' });

  done(null, {
    metadata: file.metadata,
    content
  })
  console.timeEnd(`📹 job convert #${job.id}`)
})

function convertToWebmSticker (input) {
  const output = temp.path({ suffix: '.webm' })

  return new Promise((resolve, reject) => {
    const process = ffmpeg()
      .input(input)
      .on('error', (error) => {
        reject(error)
      })
      .on('end', () => {
        ffmpeg.ffprobe(output, (_err, metadata) => {
          resolve({
            output,
            metadata
          })
        })
      })
      .noAudio()
      .addInputOptions(['-t 3'])
      .output(output)
      .videoFilters(
        'scale=512:512:force_original_aspect_ratio=decrease',
        'fps=30'
      )
      .videoBitrate('500k')
      .outputOptions(
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p'
      )
      .duration(2.9)

    process.run()
  })
}
