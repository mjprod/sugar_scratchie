import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'

const SCRIPT = fileURLToPath(new URL('./body_match.py', import.meta.url))
const PYTHON = path.join(homedir(), '.local/share/mxj-flux3-klein/venv/bin/python')

function pythonBin(): string {
  return process.env.FLUX3_KLEIN_PYTHON?.trim() || PYTHON
}

function run(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errTail = (errTail + text).slice(-2000)
      process.stderr.write(`[body] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[body] ${buf.toString()}`)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`body-match 結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

async function writeDataUri(file: string, src: string): Promise<void> {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!m) throw new Error('身材參考圖格式不對')
  await writeFile(file, Buffer.from(m[2], 'base64'))
}

/** After generation, fit the person's box to the reference. Keeps the picture if no person is found. */
export async function matchReferenceBody(generated: string, reference: string): Promise<string> {
  const python = pythonBin()
  if (!existsSync(python) || !existsSync(SCRIPT)) {
    throw new Error('本機 body match 還沒裝好')
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'body-match-'))
  const srcFile = path.join(dir, 'src.bin')
  const refFile = path.join(dir, 'ref.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(srcFile, generated)
    await writeDataUri(refFile, reference)
    await run(python, [SCRIPT, srcFile, refFile, outFile], dir)
    if (!existsSync(outFile)) throw new Error('身材對應沒寫出圖片')
    const buf = await readFile(outFile)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
