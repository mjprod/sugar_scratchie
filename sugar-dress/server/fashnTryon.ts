import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

const PYTHON = path.join(homedir(), '.local/share/fashn-vton-1.5/.venv/bin/python')
const SCRIPT = fileURLToPath(new URL('./fashn_tryon.py', import.meta.url))

export type FashnCategory = 'tops' | 'bottoms' | 'one-pieces'
export type FashnPhoto = 'model' | 'flat-lay'

function run(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errTail = (errTail + text).slice(-2000)
      process.stderr.write(`[fashn] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[fashn] ${buf.toString()}`)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`換裝結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

async function writeDataUri(file: string, src: string): Promise<void> {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!match) throw new Error('圖片格式不對')
  await writeFile(file, Buffer.from(match[2], 'base64'))
}

export async function fashnTryOn(
  person: string,
  garment: string,
  category: FashnCategory,
  photo: FashnPhoto,
): Promise<string> {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) throw new Error('FASHN 還沒裝好')
  const dir = await mkdtemp(path.join(tmpdir(), 'fashn-tryon-'))
  const personFile = path.join(dir, 'person.bin')
  const garmentFile = path.join(dir, 'garment.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(personFile, person)
    await writeDataUri(garmentFile, garment)
    await run(PYTHON, [SCRIPT, personFile, garmentFile, outFile, category, photo], dir)
    if (!existsSync(outFile)) throw new Error('換裝沒寫出圖片')
    const buf = await readFile(outFile)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
