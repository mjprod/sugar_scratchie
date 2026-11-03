import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { kleinSize, refPixelSize } from './flux3Klein.ts'

const ROOT = path.join(homedir(), '.local/share/mxj-flux18')
const DEFAULT_BIN = path.join(ROOT, 'bin/sd-cli')
const DEFAULT_DIT = path.join(
  ROOT,
  'models/Sakura-FLUX.3-Image-Klein-Q8_0-5.58GiB.gguf',
)
const DEFAULT_LLM = path.join(
  ROOT,
  'models/Sakura-TextEncoder-Qwen3VL-4B-Uncensored-Q8_0-3.99GiB.gguf',
)
const DEFAULT_VAE = path.join(ROOT, 'models/flux2-vae.safetensors')

function sdCli(): string {
  return process.env.FLUX18_SD_CLI?.trim() || DEFAULT_BIN
}
function ditPath(): string {
  return process.env.FLUX18_DIT?.trim() || DEFAULT_DIT
}
function llmPath(): string {
  return process.env.FLUX18_LLM?.trim() || DEFAULT_LLM
}
function vaePath(): string {
  return process.env.FLUX18_VAE?.trim() || DEFAULT_VAE
}

export function flux18InstallError(): string | null {
  const missing = [sdCli(), ditPath(), llmPath(), vaePath()].filter(
    (p) => !existsSync(p),
  )
  if (!missing.length) return null
  return (
    '本機 Flux 18+ 還沒裝好。把 sd-cli、Q8_0 DiT、uncensored Qwen3-VL encoder、flux2 VAE 放到 ~/.local/share/mxj-flux18。'
  )
}

// ponytail: one in-flight job; Metal can't hold two Q8_0 Kleins
let chain: Promise<unknown> = Promise.resolve()

async function writeRefs(images: string[]): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'flux18-'))
  const paths: string[] = []
  for (const [i, src] of images.entries()) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
    if (!m) continue
    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg'
    const file = path.join(dir, `ref-${i}.${ext}`)
    await writeFile(file, Buffer.from(m[2], 'base64'))
    paths.push(file)
  }
  return { dir, paths }
}

function runSdCli(args: string[], outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = sdCli()
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: path.dirname(bin),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errTail = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      errTail = (errTail + text).slice(-4000)
      process.stderr.write(`[flux-18] ${text}`)
    })
    child.stdout.on('data', (buf: Buffer) => {
      process.stderr.write(`[flux-18] ${buf.toString()}`)
    })
    child.on('error', (err) =>
      reject(err instanceof Error ? err : new Error(String(err))),
    )
    child.on('exit', (code) => {
      if (code === 0 && existsSync(outFile)) {
        resolve()
        return
      }
      reject(
        new Error(
          code === 0
            ? 'Flux 18+ 沒寫出圖片'
            : `Flux 18+ 結束（${code ?? 'signal'}）${errTail ? `\n${errTail.trim()}` : ''}`,
        ),
      )
    })
  })
}

export async function generateFlux18(input: {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: 'speed' | 'quality' | '720'
}): Promise<{ src: string; mode: string; model: string; image_mode: string }> {
  const missing = flux18InstallError()
  if (missing) throw new Error(missing)

  const refs = [...(input.images ?? []), input.image ?? ''].filter(Boolean)
  const mode = input.image_mode ?? 'speed'
  const { dir, paths } = await writeRefs(refs)
  const [width, height] = kleinSize(
    input.aspect_ratio,
    mode === '720' ? '720' : mode === 'quality',
    input.aspect_ratio === 'auto' && paths[0] ? refPixelSize(paths[0]) : null,
  )
  const outFile = path.join(dir, 'out.png')
  // sd-cli takes refs via -r / -i; Grok's <IMAGE_n> is literal junk to Qwen-VL
  const prompt = input.prompt.replace(/<IMAGE_\d+>/g, ' ').replace(/\s+/g, ' ').trim()

  const args = [
    '--diffusion-model',
    ditPath(),
    '--llm',
    llmPath(),
    '--vae',
    vaePath(),
    '--vae-format',
    'flux2',
    '-p',
    prompt,
    '--cfg-scale',
    '1.0',
    '--steps',
    '16',
    '--sampling-method',
    'euler',
    '--seed',
    '-1',
    '-W',
    String(width),
    '-H',
    String(height),
    '-o',
    outFile,
  ]
  // ponytail: first ref is img2img so the prompt can actually change clothes; extra refs stay Kontext
  if (paths[0]) {
    args.push('-i', paths[0], '--strength', '0.82')
  }
  for (const ref of paths.slice(1, 10)) {
    args.push('-r', ref)
  }

  try {
    const run = () => runSdCli(args, outFile)
    await (chain = chain.then(run, run))
    const buf = await readFile(outFile)
    return {
      src: `data:image/png;base64,${buf.toString('base64')}`,
      mode: paths.length ? 'edit' : 'generate',
      model: 'flux-18',
      image_mode: input.image_mode ?? 'speed',
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
