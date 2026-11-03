import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'

const SCRIPT = fileURLToPath(new URL('./garment_sample.py', import.meta.url))
const POSE = fileURLToPath(new URL('./pose_plate.py', import.meta.url))
const PYTHON = path.join(homedir(), '.local/share/mxj-flux3-klein/venv/bin/python')

function pythonBin(): string {
  return process.env.FLUX3_KLEIN_PYTHON?.trim() || PYTHON
}

function run(bin: string, args: string[], cwd: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errTail = (errTail + text).slice(-2000)
      process.stderr.write(`[${tag}] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[${tag}] ${buf.toString()}`)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`衣服取樣結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

async function writeDataUri(file: string, src: string): Promise<void> {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!m) throw new Error('圖片格式不對')
  await writeFile(file, Buffer.from(m[2], 'base64'))
}

async function sample(script: string, src: string, tag: string): Promise<string> {
  const python = pythonBin()
  if (!existsSync(python) || !existsSync(script)) return src
  const dir = await mkdtemp(path.join(tmpdir(), `${tag}-`))
  const srcFile = path.join(dir, 'src.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(srcFile, src)
    await run(python, [script, srcFile, outFile], dir, tag)
    if (!existsSync(outFile)) return src
    const buf = await readFile(outFile)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Drop the body in a clothing photo. A flat lay comes back unchanged. */
export async function garmentSample(clothing: string): Promise<string> {
  return sample(SCRIPT, clothing, 'garment')
}

/** Turn a pose photo into a gray silhouette so its outfit cannot be copied. */
export async function posePlate(src: string): Promise<string> {
  return sample(POSE, src, 'pose')
}
