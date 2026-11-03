import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { FashnCategory } from './fashnTryon.ts'

const LEFFA_PYTHON = path.join(homedir(), '.local/share/Leffa/.venv/bin/python')
const LEFFA_SCRIPT = fileURLToPath(new URL('./leffa_tryon.py', import.meta.url))

function run(bin: string, args: string[], cwd: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0', PYTORCH_ENABLE_MPS_FALLBACK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      else reject(new Error(`換裝結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

async function writeDataUri(file: string, src: string): Promise<void> {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!match) throw new Error('圖片格式不對')
  await writeFile(file, Buffer.from(match[2], 'base64'))
}

async function pngResult(outFile: string): Promise<string> {
  if (!existsSync(outFile)) throw new Error('換裝沒寫出圖片')
  const buf = await readFile(outFile)
  return `data:image/png;base64,${buf.toString('base64')}`
}

export async function leffaTryOn(person: string, garment: string, category: FashnCategory): Promise<string> {
  if (!existsSync(LEFFA_PYTHON) || !existsSync(LEFFA_SCRIPT)) throw new Error('Leffa 還沒裝好')
  const dir = await mkdtemp(path.join(tmpdir(), 'leffa-tryon-'))
  const personFile = path.join(dir, 'person.png')
  const garmentFile = path.join(dir, 'garment.png')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(personFile, person)
    await writeDataUri(garmentFile, garment)
    await run(LEFFA_PYTHON, [LEFFA_SCRIPT, personFile, garmentFile, outFile, category], dir, 'leffa')
    return pngResult(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
