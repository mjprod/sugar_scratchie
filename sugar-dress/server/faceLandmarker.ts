import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

const PYTHON = path.join(homedir(), '.local/share/sugar-dress-face/bin/python')
const SCRIPT = fileURLToPath(new URL('./face_landmarker.py', import.meta.url))

function run(image: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, image], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let errTail = ''
    child.stdout.on('data', (buf: Buffer) => {
      out += buf.toString()
    })
    child.stderr.on('data', (buf: Buffer) => {
      errTail = (errTail + buf.toString()).slice(-1500)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(`臉部輪廓結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

/** Pixel points around the face. Empty when no face is found. */
export async function faceOval(src: string): Promise<number[][]> {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) return []
  const match = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!match) return []
  const dir = await mkdtemp(path.join(tmpdir(), 'face-oval-'))
  const file = path.join(dir, 'in.png')
  try {
    await writeFile(file, Buffer.from(match[2], 'base64'))
    const text = await run(file)
    const parsed = JSON.parse(text) as { points?: number[][] }
    const points = parsed.points ?? []
    return points.length >= 3 ? points : []
  } catch {
    return []
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
