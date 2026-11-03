import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

const PYTHON = path.join(homedir(), '.local/share/mxj-flux3-klein/venv/bin/python')
const EXTRACT = fileURLToPath(new URL('./extract_person.py', import.meta.url))
const KEEP = fileURLToPath(new URL('./keep_body.py', import.meta.url))
const COMPOSITE = fileURLToPath(new URL('./composite_bg.py', import.meta.url))

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
      process.stderr.write(`[detail] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[detail] ${buf.toString()}`)
    })
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${tag} 結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`))
    })
  })
}

async function writeDataUri(file: string, src: string): Promise<void> {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!match) throw new Error('圖片格式不對')
  await writeFile(file, Buffer.from(match[2], 'base64'))
}

async function readPng(file: string): Promise<string> {
  const buf = await readFile(file)
  return `data:image/png;base64,${buf.toString('base64')}`
}

export async function extractPerson(
  src: string,
  crop: { x: number; y: number; w: number; h: number },
  method: 'corridor' | 'modnet' = 'corridor',
): Promise<string> {
  const python = pythonBin()
  if (!existsSync(python) || !existsSync(EXTRACT)) throw new Error('人物抽出還沒裝好')
  const dir = await mkdtemp(path.join(tmpdir(), 'extract-person-'))
  const srcFile = path.join(dir, 'src.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(srcFile, src)
    await run(
      python,
      [EXTRACT, srcFile, outFile, String(crop.x), String(crop.y), String(crop.w), String(crop.h), method],
      dir,
      '抽出人物',
    )
    if (!existsSync(outFile)) throw new Error('抽出沒寫出圖片')
    return readPng(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function keepBody(cutout: string, generated: string): Promise<string> {
  const python = pythonBin()
  if (!existsSync(python) || !existsSync(KEEP)) throw new Error('身材對齊還沒裝好')
  const dir = await mkdtemp(path.join(tmpdir(), 'keep-body-'))
  const cutFile = path.join(dir, 'cut.bin')
  const genFile = path.join(dir, 'gen.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(cutFile, cutout)
    await writeDataUri(genFile, generated)
    await run(python, [KEEP, cutFile, genFile, outFile], dir, '保留身材')
    if (!existsSync(outFile)) throw new Error('保留身材沒寫出圖片')
    return readPng(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function compositeBackground(
  person: string,
  background: string,
  width: number,
  height: number,
): Promise<string> {
  const python = pythonBin()
  if (!existsSync(python) || !existsSync(COMPOSITE)) throw new Error('套背景還沒裝好')
  const dir = await mkdtemp(path.join(tmpdir(), 'composite-bg-'))
  const personFile = path.join(dir, 'person.bin')
  const bgFile = path.join(dir, 'bg.bin')
  const outFile = path.join(dir, 'out.png')
  try {
    await writeDataUri(personFile, person)
    await writeDataUri(bgFile, background)
    await run(
      python,
      [COMPOSITE, personFile, bgFile, outFile, String(width), String(height)],
      dir,
      '套背景',
    )
    if (!existsSync(outFile)) throw new Error('套背景沒寫出圖片')
    return readPng(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
