import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PYTHON = path.join(homedir(), '.local/share/Leffa/.venv/bin/python')
const SCRIPT = fileURLToPath(new URL('./extract_clothes.py', import.meta.url))

function run(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      errTail = (errTail + buf.toString()).slice(-2000)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        const line = errTail
          .split('\n')
          .map((part) => part.trim())
          .filter((part) => part && !part.includes('onnxruntime'))
          .at(-1)
        reject(new Error(line || '抽出衣服失敗'))
      }
    })
  })
}

export async function extractClothes(src: string): Promise<string> {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) throw new Error('SCHP 還沒裝好')
  const match = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!match) throw new Error('圖片格式不對')
  const dir = await mkdtemp(path.join(tmpdir(), 'extract-clothes-'))
  const srcFile = path.join(dir, 'src.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeFile(srcFile, Buffer.from(match[2], 'base64'))
    await run([SCRIPT, srcFile, outFile], dir)
    if (!existsSync(outFile)) throw new Error('抽出衣服沒寫出圖片')
    const buf = await readFile(outFile)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
