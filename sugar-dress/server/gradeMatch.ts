import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'

const ROOT = path.join(homedir(), '.local/share/mxj-grade-images')
const DEFAULT_SKILL = path.join(ROOT, 'skills/grade-images')
const DEFAULT_PY = path.join(
  homedir(),
  '.local/share/mxj-flux3-klein/venv/bin/python',
)

function skillDir(): string {
  return process.env.GRADE_SKILL?.trim() || DEFAULT_SKILL
}
function pythonBin(): string {
  return (
    process.env.GRADE_PYTHON?.trim() ||
    process.env.FLUX3_KLEIN_PYTHON?.trim() ||
    DEFAULT_PY
  )
}

const SKIN_MATCH = fileURLToPath(new URL('./skin_match.py', import.meta.url))

function paths() {
  const skill = skillDir()
  const scripts = path.join(skill, 'scripts')
  return {
    python: pythonBin(),
    scripts,
    skin: SKIN_MATCH,
    match: path.join(scripts, 'match.py'),
    grade: path.join(scripts, 'grade.py'),
    template: path.join(skill, 'assets/recipes/neutral-correction.json'),
  }
}

export function gradeInstallError(): string | null {
  const { python, skin, match, grade, template } = paths()
  if ([python, skin, match, grade, template].every((p) => existsSync(p))) return null
  return '本機 grade-images 還沒裝好。clone 到 ~/.local/share/mxj-grade-images，並用 Klein venv 的 Python。'
}

function run(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errTail = (errTail + text).slice(-3000)
      process.stderr.write(`[grade] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[grade] ${buf.toString()}`)
    })
    child.on('error', (err) =>
      reject(err instanceof Error ? err : new Error(String(err))),
    )
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `grade-images 結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`,
        ),
      )
    })
  })
}

function writeDataUri(file: string, src: string): Promise<void> {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!m) return Promise.reject(new Error('色澤參考圖格式不對'))
  return writeFile(file, Buffer.from(m[2], 'base64'))
}

export async function matchReferenceColour(
  generated: string,
  reference: string,
): Promise<string> {
  const missing = gradeInstallError()
  if (missing) throw new Error(missing)

  const { python, scripts, skin, template } = paths()
  const dir = await mkdtemp(path.join(tmpdir(), 'grade-match-'))
  const srcFile = path.join(dir, 'src.bin')
  const refFile = path.join(dir, 'ref.bin')
  const outFile = path.join(dir, 'out.png')

  try {
    await writeDataUri(srcFile, generated)
    await writeDataUri(refFile, reference)
    // Skin median is moved fully onto the reference. AVIF and WebP are decoded
    // here; grade-images itself still only accepts JPEG and PNG.
    await run(
      python,
      [skin, srcFile, refFile, outFile, '--scripts', scripts, '--template', template],
      dir,
    )
    if (!existsSync(outFile)) throw new Error('色澤對應沒寫出圖片')
    const buf = await readFile(outFile)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
