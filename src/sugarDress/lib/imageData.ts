/** Convert blob:/http(s):/data: image sources into a data URI for xAI edits. */
export async function toDataUri(src: string): Promise<string> {
  if (src.startsWith('data:')) return src

  const res = await fetch(src)
  if (!res.ok) {
    throw new Error('Failed to read selected image')
  }
  const blob = await res.blob()

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('Failed to encode selected image'))
    }
    reader.onerror = () => reject(new Error('Failed to encode selected image'))
    reader.readAsDataURL(blob)
  })
}
