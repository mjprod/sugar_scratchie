import { parseAtMentions } from './promptRefs'

const POSE_SOURCE =
  '換動作|改動作|換姿勢|改姿勢|換姿態|姿勢|姿態|\\bpose\\b|舉手|轉身|躺下|蹲下|跳躍|跳舞|坐下|站著|走路|跑步|standing|sitting|walking|running'

/** User asked for a different pose in the prompt itself. Clothing words do not count. */
export function asksForPoseChange(prompt: string): boolean {
  return new RegExp(POSE_SOURCE, 'i').test(prompt)
}

/** A product shot has almost no skin. A worn photo is mostly a person. */
export function wornClothingPhoto(data: ArrayLike<number>): boolean {
  let skin = 0
  let n = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    n += 1
    if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 && r - b > 15) skin += 1
  }
  return n > 0 && skin / n > 0.04
}

/** A garment image or clothing words. Pose-only text does not count. */
export function replacesClothes(userPrompt: string, clothingIndex: number | null): boolean {
  if (clothingIndex != null) return true
  const rest = userPrompt.replace(new RegExp(POSE_SOURCE, 'gi'), '').replace(/[\s,，.。!！?？、]/g, '')
  return rest.length > 0
}

/** Background is generated around the person, then the original person pixels are put back.
 *  The reference must already have the old room removed, or the edit copies that room. */
export function backgroundPrompt(text: string, hasPlace: boolean): string {
  const words = text.trim()
  const lines = [
    words
      ? `Paint this location behind the person in the first image: ${words}`
      : 'Paint a new location behind the person in the first image.',
    'The white around the person is empty. It must be completely replaced. Do not restore any earlier room.',
    'Match this person: same camera angle, same scale, and the feet meet the ground, as one photograph.',
    'Do not relight, recolor, brighten, darken, or move the person. Their light stays exactly as in the first image.',
    'No other people, no faces, no text.',
  ]
  if (hasPlace) {
    lines.push(
      'The second image is the location to paint. Use that place. Do not copy its people, and do not copy its light onto the person.',
    )
  }
  return lines.join('\n')
}

/** Source is always index 0. Clothing and pose are added only when present. */
export function dressImages(input: {
  source: string
  clothing?: string | null
  pose?: string | null
  extras?: string[]
}): { images: string[]; clothingIndex: number | null; poseIndex: number | null } {
  const images = [input.source]
  const add = (src: string) => {
    const found = images.indexOf(src)
    if (found >= 0) return found
    images.push(src)
    return images.length - 1
  }
  const clothingIndex = input.clothing ? add(input.clothing) : null
  const poseIndex = input.pose ? add(input.pose) : null
  for (const src of input.extras ?? []) add(src)
  return { images, clothingIndex, poseIndex }
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth']

/** Klein has no <IMAGE_n> token. Ordinals are how its edit captions name references. */
export function imagePhrase(index: number): string {
  const word = ORDINALS[index]
  return word ? `the ${word} image` : `image ${index + 1}`
}

/** Point each @n at that image's index in the final list. */
export function rewriteAtRefs(
  prompt: string,
  pool: string[],
  images: string[],
): { apiPrompt: string; missing: number[] } {
  const missing: number[] = []
  let apiPrompt = prompt
  for (const n of parseAtMentions(prompt)) {
    const src = pool[n - 1]
    const idx = src ? images.indexOf(src) : -1
    if (!src || idx < 0) {
      missing.push(n)
      continue
    }
    apiPrompt = apiPrompt.replaceAll(new RegExp(`@${n}\\b`, 'g'), imagePhrase(idx))
  }
  return { apiPrompt, missing }
}

/**
 * Clothing edit. Pose, expression, and skin stay on the source person
 * unless a pose reference is attached or the prompt itself asks for a new pose.
 * A pose reference is the action only. Its outfit is never the garment.
 */
export function dressEditPrompt(input: {
  userPrompt: string
  apiPrompt: string
  clothingIndex: number | null
  poseIndex: number | null
  /** Remove clothes. Nipples and genitals stay covered by smooth skin. */
  undress?: boolean
  /** Body pose may change. The face stays the source person. */
  lockFace?: boolean
}): string {
  const person = imagePhrase(0)
  if (input.undress) {
    return [
      `Remove the outfit from the person in ${person}. Erase every edge, strap, lace, and seam. Do not recolor the old garment in place.`,
      "Where the fabric was, continue this person's skin. Smooth over the nipples and the genital area: no nipple, no areola, no genital shape, no crease, and no leftover outline.",
      'Keep the same face, pose, chest size, height, and shape, skin color, and background. Do not brighten or darken the skin.',
    ].join('\n')
  }
  const lines: string[] = []
  const words = input.apiPrompt.trim()
  const changing = replacesClothes(input.userPrompt, input.clothingIndex)
  if (input.lockFace && input.poseIndex != null) {
    lines.push(
      `Change the pose of the person in ${person}. Do not keep the original arm position. Both arms hang down at the sides, away from the waist. The hands come off the hips and hang open beside the thighs. The torso stays upright. Move every strand of hair that hangs in front of the body behind the back. Hair must not lie on the chest, stomach, shoulders, or arms. The front of the body stays clear of hair. Do not change the hair color or length.`,
    )
  } else if (input.clothingIndex != null) {
    const cloth = imagePhrase(input.clothingIndex)
    lines.push(
      `Change the outfit of the person in ${person} to the clothes in ${cloth}. Copy that outfit exactly: the same pieces, colors, sleeves, collar, length, and hardware. Do not design a different outfit. Keep its neckline, collar, shoulder coverage, badges, and sleeves. Do not lower the neckline, bare the shoulders, or remove a collar, badge, or sleeve. Remove the original outfit completely, including every edge, strap, lace, and seam. Do not keep the original bare shoulders. Do not recolor the old garment in place. ${cloth} is clothing, not a body. Do not copy a chest, waist, or height from it, even when the clothes are a dress, a shirt, or a full outfit that covers the chest. Her chest size and shape stay the ones in ${person}. A smaller or tighter garment does not reduce her chest. The chest outline stays the same shape as the first image. Drape the clothes over the bust that is already there.`,
    )
    if (words) lines.push(words)
  } else if (changing && words) {
    lines.push(
      `Change the outfit of the person in ${person} to: ${words}. Remove the original outfit completely, including every edge, strap, lace, and seam. Do not recolor the old garment in place. A full outfit, dress, or shirt does not change her chest size, chest shape, waist, or hips. Those stay as they are in ${person}.`,
    )
  } else {
    lines.push(`Edit the person in ${person}.`)
    if (words) lines.push(words)
  }
  if (input.poseIndex != null) {
    const pose = imagePhrase(input.poseIndex)
    lines.push(
      input.lockFace
        ? `${pose} is a pose and action reference only. It is a flat gray silhouette, not a photo of a dressed person. Match that silhouette's body only: limb angles, hand position, and torso lean. Do not turn, replace, or redraw the face. The hair is separate from the face. The face in ${person} stays the same person: same eyes, nose, mouth, jaw, and expression. ${pose} contributes no face and no clothing. Put every strand of hair that hangs in front of the body behind the character. Hair must not lie on the chest, stomach, shoulders, or arms. Sweep it behind the back. Do not leave the hair in front. Do not change the hair color or length.`
        : `${pose} is a pose and action reference only. It is a flat gray silhouette, not a photo of a dressed person. Match that silhouette's pose and action: limb angles, hand position, torso lean, and head angle. The gray is not clothing, not a face, and not an outfit. Do not copy clothes, accessories, colors, or identity from it. ${pose} contributes no clothing.`,
    )
  } else if (asksForPoseChange(input.userPrompt)) {
    lines.push('Apply only the pose change written above.')
  } else {
    lines.push('Do not change the pose.')
  }
  lines.push(
    input.lockFace
      ? "Keep the same face, expression, skin color, skin sheen, and background. Keep this person's chest, waist, hips, and shoulders at the same size and shape. The arms and hands keep the same length and thickness, but their angles follow the pose reference. Move the arms, hands, and torso so they match the pose reference. Do not leave them in the original pose. Do not melt the joints or add extra limbs. Put every strand of hair that hangs in front of the body behind the character. Do not leave the hair in front. The bust volume and shape stay as they are under the clothes. Do not cut the neckline open to expose it. Do not compress, flatten, bind, or shrink it. The clothes fit the body. The body does not change to fit the clothes. Do not brighten, darken, tan, or gloss the skin."
      : "Keep the same face, expression, skin color, skin sheen, neck, and background. Keep this person's chest, waist, hips, shoulders, arms, and hands at the same size and shape. Do not redraw the neck, arms, or hands. The bust volume and shape stay as they are under the clothes. Do not cut the neckline open to expose it. Do not compress, flatten, bind, or shrink it. The clothes fit the body. The body does not change to fit the clothes. Do not brighten, darken, tan, or gloss the skin.",
  )
  return lines.join('\n')
}

const BIKINI_COLORS = [
  'black',
  'white',
  'red',
  'burgundy',
  'hot pink',
  'navy',
  'emerald',
  'cobalt',
  'chocolate',
  'ivory',
  'plum',
  'leopard-print',
]

const BIKINI_CUTS = [
  'sexy bikini: triangle top, thin straps, low-rise bottom',
  'sexy bikini: string top and side-tie thong bottom',
  'sexy bikini: bandeau top and high-cut bottom',
  'sexy bikini: halter top and brazilian bottom',
  'sexy bikini: underwire balconette top and tie-side bottom',
  'sexy bikini: one-shoulder top and high-leg bottom',
  'sexy bikini: micro triangle top with chain straps and a thong bottom',
  'sexy bikini: wrap top and ruched bottom',
  'sexy lace lingerie: underwire lace bra and matching lace panties',
  'sexy lace lingerie: balconette lace bra and lace thong',
  'sexy lace lingerie: sheer lace bralette and high-cut lace panties',
  'sexy lace lingerie: floral lace bra and lace cheeky',
  'sexy lace lingerie: strappy lace bra and strappy lace panties',
  'sexy lace lingerie: longline lace bra and lace briefs',
  'sexy lace lingerie: demi lace bra and lace thong',
  'sexy lace lingerie: embroidered lace bra and scalloped lace panties',
  'erotic lingerie: lace teddy with a deep neckline',
  'erotic lingerie: garter belt, stockings, lace bra and panties',
  'erotic lingerie: underbust corset, lace panties, and garter straps',
  'erotic lingerie: sheer babydoll and matching panties',
  'erotic lingerie: fishnet bodysuit',
  'erotic lingerie: strappy harness over a lace bra and thong',
  'erotic lingerie: satin teddy with lace trim',
  'erotic lingerie: lace bodysuit with a high-cut leg',
]

export const BIKINI_LOOKS = BIKINI_COLORS.flatMap((color) =>
  BIKINI_CUTS.map((cut) => `${color} ${cut}`),
)

const usedBikinis = new Set<string>()

export function pickBikinis(count: number, random: () => number = Math.random): string[] {
  const n = Math.min(count, BIKINI_LOOKS.length)
  let bag = BIKINI_LOOKS.filter((look) => !usedBikinis.has(look))
  if (bag.length < n) {
    usedBikinis.clear()
    bag = [...BIKINI_LOOKS]
  } else {
    bag = [...bag]
  }
  const out: string[] = []
  while (out.length < n) {
    const i = Math.min(bag.length - 1, Math.floor(random() * bag.length))
    const look = bag.splice(i, 1)[0]
    if (look) out.push(look)
  }
  for (const look of out) usedBikinis.add(look)
  return out
}

export const COSPLAY_THEMES: { id: string; label: string; costumes: string[] }[] = [
  {
    id: 'police',
    label: 'Police',
    costumes: [
      'a sexy navy police costume: shirt buttoned to the collar, a large silver star badge on the chest, shoulder epaulettes, a black duty belt with a holster, a peaked police cap with a badge, and a short navy skirt. Chest and stomach stay covered. The cap leaves the face clear',
      'a sexy police costume: white uniform shirt buttoned up, black necktie, a large chest badge, a navy peaked police cap with a badge, a duty belt with a radio and a holster, and a short skirt. Chest and stomach stay covered. The cap leaves the face clear',
      'a sexy police costume: dark navy jacket worn closed, a large silver badge, shoulder epaulettes, a black utility belt with a holster, a peaked police cap with a badge, and a short skirt. Chest and stomach stay covered. The cap leaves the face clear',
    ],
  },
  {
    id: 'nurse',
    label: 'Nurse',
    costumes: [
      'a sexy nurse costume: white dress with a high neckline and a short hem, a white apron with a red cross, a nurse cap with a red cross, and a stethoscope. Chest and stomach stay covered. The cap leaves the face clear',
      'a sexy nurse costume: white dress buttoned to the collar, a red-cross armband, a white apron with a red cross, and a nurse cap with a red cross. Chest and stomach stay covered. The cap leaves the face clear',
      'a sexy nurse costume: light blue dress buttoned to the collar, a white apron with a red cross, a nurse cap with a red cross, and a stethoscope. Chest and stomach stay covered. The cap leaves the face clear',
    ],
  },
  {
    id: 'teacher',
    label: 'Teacher',
    costumes: [
      'a sexy teacher costume: white blouse buttoned up with a large neck bow, a brown tweed blazer worn closed, and a red tartan pencil skirt. Chest and stomach stay covered',
      'a sexy teacher costume: cream blouse with a large neck bow, a navy cardigan worn closed, and a grey plaid pleated skirt. Chest and stomach stay covered',
      'a sexy teacher costume: white shirt buttoned up with a black neck bow, a short charcoal blazer worn closed, and a green tartan mini skirt. Chest and stomach stay covered',
    ],
  },
  {
    id: 'gym',
    label: 'Gym Girl',
    costumes: [
      'a sexy gym costume: a bright high-neck leotard that covers the chest and stomach, striped leg warmers, a sweat headband that leaves the face clear, and wristbands. Chest and stomach stay covered',
      'a sexy gym costume: a striped track jacket worn closed over a high-neck top, high-waist athletic shorts, a sweat headband that leaves the face clear, and wristbands. Chest and stomach stay covered',
      'a sexy gym costume: a color-block high-neck athletic top, high-waist biker shorts, a sweat headband that leaves the face clear, wristbands, and sneakers. Chest and stomach stay covered',
    ],
  },
  {
    id: 'flight',
    label: 'Flight Attendant',
    costumes: [
      'a sexy flight attendant costume: navy jacket buttoned closed, a gold wings pin on the lapel, a bright red silk scarf, a short pencil skirt, and a pillbox hat. Chest and stomach stay covered. The hat leaves the face clear',
      'a sexy flight attendant costume: sky-blue jacket buttoned closed, a gold wings pin on the lapel, a patterned neck scarf, a short skirt, and a pillbox hat. Chest and stomach stay covered. The hat leaves the face clear',
      'a sexy flight attendant costume: navy jacket worn closed over a buttoned white blouse, a gold wings pin, a red scarf, a short skirt, and a pillbox hat. Chest and stomach stay covered. The hat leaves the face clear',
    ],
  },
  {
    id: 'fire',
    label: 'Fire Fighter',
    costumes: [
      'a sexy firefighter costume: a black turnout coat worn closed with wide yellow reflective stripes, red suspenders, dark pants, and a red helmet. The helmet leaves the whole face clear. Chest and stomach stay covered',
      'a sexy firefighter costume: a red jacket worn closed with yellow reflective stripes, black suspenders, dark pants, and a red helmet. The helmet leaves the whole face clear. Chest and stomach stay covered',
      'a sexy firefighter costume: a short black coat worn closed with yellow reflective bands, suspenders, dark pants, and a red helmet. The helmet leaves the whole face clear. Chest and stomach stay covered',
    ],
  },
  {
    id: 'cow',
    label: 'Cow Girl',
    costumes: [
      'a sexy cowgirl costume: a brown cowboy hat, a fringed suede vest worn closed over a buttoned plaid shirt, a short denim skirt, a wide belt with a large silver buckle, and cowboy boots. Chest and stomach stay covered. The hat leaves the face clear',
      'a sexy cowgirl costume: a black cowboy hat, a cow-print vest worn closed over a buttoned white shirt, a high-waist denim skirt, a large belt buckle, and cowboy boots. Chest and stomach stay covered. The hat leaves the face clear',
      'a sexy cowgirl costume: a tan cowboy hat, a fringed jacket worn closed over a buttoned plaid shirt, a high-waist denim skirt, an oversized belt buckle, and cowboy boots. Chest and stomach stay covered. The hat leaves the face clear',
    ],
  },
  {
    id: 'greek',
    label: 'Greek Mythos',
    costumes: [
      'a sexy Greek myth costume: a white chiton pinned at both shoulders, a gold Greek-key border, a gold cord belt, and a gold laurel wreath. Chest and stomach stay covered. The wreath leaves the face clear',
      'a sexy Greek myth costume: an ivory draped gown with a closed neckline, gold meander trim, a gold belt, gold arm cuffs, and a gold laurel wreath. Chest and stomach stay covered. The wreath leaves the face clear',
      'a sexy Greek myth costume: a white draped dress with a high neckline, a gold Greek-key hem, gold sandals, and a gold laurel wreath. Chest and stomach stay covered. The wreath leaves the face clear',
    ],
  },
  {
    id: 'egyptian',
    label: 'Egyptian',
    costumes: [
      'a sexy Egyptian costume: a white linen sheath dress with a high neckline, a large broad gold collar, a gold cobra headband, and gold armbands. Chest and stomach stay covered. The headband leaves the face clear',
      'a sexy Egyptian costume: a pleated white linen dress with a closed bodice, a wide gold-and-turquoise collar, and a striped nemes headdress. Chest and stomach stay covered. The headdress leaves the face clear',
      'a sexy Egyptian costume: a white linen dress wrapped closed, an oversized gold collar, a gold cobra headband, a gold belt, and gold armbands. Chest and stomach stay covered. The headband leaves the face clear',
    ],
  },
]

const usedCosplay = new Map<string, Set<string>>()

export function pickCosplay(
  themeId: string,
  count: number,
  random: () => number = Math.random,
): string[] {
  const theme = COSPLAY_THEMES.find((item) => item.id === themeId)
  if (!theme) return []
  const seen = usedCosplay.get(themeId) ?? new Set<string>()
  const n = Math.min(count, theme.costumes.length)
  let bag = theme.costumes.filter((costume) => !seen.has(costume))
  if (bag.length < n) {
    seen.clear()
    bag = [...theme.costumes]
  } else {
    bag = [...bag]
  }
  const out: string[] = []
  while (out.length < n) {
    const i = Math.min(bag.length - 1, Math.floor(random() * bag.length))
    const costume = bag.splice(i, 1)[0]
    if (costume) out.push(costume)
  }
  for (const costume of out) seen.add(costume)
  usedCosplay.set(themeId, seen)
  return out
}

function compactTheme(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Card theme labels ("Cowgirl", "Fire Fighter") onto a Dress costume id. */
export function matchCosplayTheme(cardTheme: string): string {
  const key = compactTheme(cardTheme)
  if (!key) return ''
  for (const theme of COSPLAY_THEMES) {
    if (key === theme.id || key === compactTheme(theme.label)) return theme.id
  }
  const aliases: Record<string, string> = {
    cowgirl: 'cow',
    cowboy: 'cow',
    firefighter: 'fire',
    fireman: 'fire',
    flightattendant: 'flight',
    stewardess: 'flight',
    gymgirl: 'gym',
    greekmyth: 'greek',
    greekmythos: 'greek',
    greekgoddess: 'greek',
  }
  const id = aliases[key] ?? ''
  return COSPLAY_THEMES.some((theme) => theme.id === id) ? id : ''
}

/** Clothes become this costume. The person underneath is not redrawn. */
export function cosplayPrompt(costume: string): string {
  return [
    dressEditPrompt({
      userPrompt: '',
      apiPrompt: `Do not redraw the breasts. They keep the same roundness, the same height, and the same size as in the first image. The costume covers those breasts. It does not replace them with smaller ones. Covering the chest does not mean drawing a smaller chest. The skin color and skin sheen stay exactly as in the first image on the face, neck, chest, stomach, arms, and legs. Costume dye must not move onto the skin. A white costume does not lighten the skin. A black costume does not darken the skin. A colored costume does not tint the skin. Her chest size and shape stay exactly the same under the new clothes. A shirt, vest, jacket, or dress does not make the chest smaller, flatter, rounder, or higher. Do not compress, flatten, lift, bind, or shrink the chest. Replace only the clothes with this sexy costume: ${costume}. The theme must be obvious at a glance. Every named signature piece must be large and clearly visible. Do not drop the hat, cap, badge, scarf, pin, stripes, wreath, or collar. Do not simplify the costume into a plain shirt, plain dress, or plain skirt. Drape the clothes over the bust that is already in the first image. A smaller costume does not reduce her chest. The chest outline stays the same shape. The costume covers the chest and the stomach completely. No bare chest and no bare stomach. Keep the costume pieces and the costume colors. Those colors stay on the clothes. Do not design a different outfit.`,
      clothingIndex: null,
      poseIndex: null,
    }),
    'The face, neck, skin color, skin sheen, chest, waist, shoulders, legs, arms, and hands stay identical to the first image. Do not redraw them. Do not tan, pale, gloss, or recolor the skin. Costume dye must not move onto the skin. Do not redraw the breasts. The chest size and shape stay exactly as they are in the first image, including under a shirt, vest, jacket, or dress. Do not compress, flatten, lift, bind, or shrink the chest. Only the costume changes.',
  ].join('\n')
}

/** Clothes become this sexy bikini, lace lingerie, or erotic lingerie. The person underneath is not redrawn. */
export function autoBikiniPrompt(look: string): string {
  return [
    dressEditPrompt({
      userPrompt: look,
      apiPrompt: `Replace only the clothes with this exact look: ${look}. Keep this color and this cut. Do not substitute a different bikini or a plain black lace set. It must stay a sexy bikini, sexy lace lingerie, or erotic lingerie.`,
      clothingIndex: null,
      poseIndex: null,
    }),
    'No regular clothes. No dress, shirt, skirt, jacket, coat, or trousers. A teddy, garter set, corset, babydoll, fishnet bodysuit, or harness is erotic lingerie.',
    'The face, neck, skin color, skin sheen, chest, waist, shoulders, legs, arms, and hands stay identical to the first image. Do not redraw them. Do not tan, pale, gloss, or recolor the skin. Only the clothes change.',
  ].join('\n')
}

const isDirectRun = String(
  (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1] ?? '',
).includes('dressEdit')
if (isDirectRun) {
  const locked = dressEditPrompt({
    userPrompt: '紅色洋裝',
    apiPrompt: '紅色洋裝',
    clothingIndex: null,
    poseIndex: null,
  })
  if (
    !locked.startsWith('Change the outfit') ||
    !locked.includes('紅色洋裝') ||
    !locked.includes('Remove the original outfit') ||
    !locked.includes('does not change her chest size') ||
    !locked.includes('Do not compress, flatten, bind, or shrink it') ||
    !locked.includes('Do not recolor the old garment in place') ||
    locked.includes('<IMAGE_') ||
    locked.includes('must stay identical')
  ) {
    throw new Error('locked clothes prompt')
  }
  const posed = dressEditPrompt({
    userPrompt: '換成這件',
    apiPrompt: '換成這件',
    clothingIndex: 1,
    poseIndex: 2,
  })
  if (
    !posed.includes('the third image') ||
    !posed.includes('pose and action reference only') ||
    !posed.includes('contributes no clothing') ||
    !posed.includes('Copy that outfit exactly') ||
    !posed.includes('Do not design a different outfit') ||
    !posed.includes('Do not lower the neckline') ||
    posed.includes('show that chest') ||
    !posed.includes('sleeves') ||
    !posed.includes('does not change to fit the clothes') ||
    !posed.includes('full outfit that covers the chest') ||
    !posed.includes('does not reduce her chest') ||
    !posed.includes('same shape as the first image') ||
    !posed.includes('Do not compress, flatten, bind, or shrink it') ||
    !posed.includes('same size and shape') ||
    !posed.includes('Remove the original outfit') ||
    !posed.includes('Do not recolor the old garment in place') ||
    posed.includes('must stay identical') ||
    posed.includes('<IMAGE_')
  ) {
    throw new Error('pose prompt')
  }
  const faceLocked = dressEditPrompt({
    userPrompt: '',
    apiPrompt: '',
    clothingIndex: null,
    poseIndex: 1,
    lockFace: true,
  })
  if (
    !faceLocked.includes('Do not turn, replace, or redraw the face') ||
    !faceLocked.includes('The hair is separate from the face') ||
    !faceLocked.includes('The front of the body stays clear of hair') ||
    !faceLocked.includes('Do not leave the hair in front') ||
    !faceLocked.includes('same eyes, nose, mouth, jaw') ||
    !faceLocked.includes('Put every strand of hair that hangs in front of the body behind the character') ||
    !faceLocked.includes('Move the arms, hands, and torso so they match the pose reference') ||
    !faceLocked.includes('Both arms hang down at the sides') ||
    !faceLocked.includes('The hands come off the hips') ||
    !faceLocked.includes('Do not keep the original arm position') ||
    faceLocked.startsWith('Edit the person') ||
    faceLocked.includes('Do not redraw the neck, arms, or hands') ||
    faceLocked.includes('head angle')
  ) {
    throw new Error('pose face lock')
  }
  const poseOnly = dressEditPrompt({
    userPrompt: '坐下',
    apiPrompt: '坐下',
    clothingIndex: null,
    poseIndex: 1,
  })
  const backdrop = backgroundPrompt('夜裡的海邊', true)
  if (
    !backdrop.startsWith('Paint this location') ||
    !backdrop.includes('Do not relight') ||
    !backdrop.includes('completely replaced') ||
    !backdrop.includes('the first image') ||
    !backdrop.includes('The second image') ||
    !backdrop.includes('夜裡的海邊') ||
    backdrop.includes('<IMAGE_')
  ) {
    throw new Error('background prompt')
  }
  if (backgroundPrompt('房間', false).includes('second image')) throw new Error('background place')
  const bare = dressEditPrompt({
    userPrompt: '洋裝',
    apiPrompt: '洋裝',
    clothingIndex: 1,
    poseIndex: null,
    undress: true,
  })
  if (
    !bare.includes('chest size, height, and shape') ||
    !bare.includes('no nipple') ||
    !bare.includes('no leftover outline') ||
    bare.includes('Replace the clothes') ||
    bare.includes('洋裝')
  ) {
    throw new Error('undress prompt')
  }
  if (poseOnly.includes('entire original outfit') || poseOnly.includes('Put every strand of hair that hangs in front of the body behind the character') || !replacesClothes('坐下，白色襯衫', null) || replacesClothes('坐下', null)) {
    throw new Error('pose-only stripped clothes')
  }
  const asked = dressEditPrompt({
    userPrompt: '坐下，白色襯衫',
    apiPrompt: '坐下，白色襯衫',
    clothingIndex: null,
    poseIndex: null,
  })
  if (!asked.includes('pose change written')) throw new Error('prompt pose')
  const packed = dressImages({ source: 'a', clothing: 'b', pose: 'c', extras: ['a', 'd'] })
  if (packed.images.join() !== 'a,b,c,d' || packed.clothingIndex !== 1 || packed.poseIndex !== 2) {
    throw new Error('image order')
  }
  const rewritten = rewriteAtRefs('看 @2', ['person', 'bg'], packed.images.slice(0, 0).concat(['person', 'bg']))
  if (rewritten.missing.length || rewritten.apiPrompt !== '看 the second image') {
    throw new Error('at rewrite')
  }
  const bikini = autoBikiniPrompt(BIKINI_LOOKS[0])
  const threeBikinis = pickBikinis(3, () => 0)
  const nextBikinis = pickBikinis(3, () => 0)
  if (
    !bikini.includes(BIKINI_LOOKS[0]) ||
    !bikini.includes('Keep this color and this cut') ||
    !bikini.includes('stay identical to the first image') ||
    !bikini.includes('Only the clothes change') ||
    !bikini.includes('No regular clothes') ||
    !bikini.includes('Do not change the pose') ||
    BIKINI_LOOKS.length < 24 ||
    BIKINI_LOOKS.some((look) => !/bikini|lace lingerie|erotic lingerie/.test(look)) ||
    !BIKINI_LOOKS.some((look) => look.includes('erotic lingerie: garter belt')) ||
    threeBikinis.length !== 3 ||
    new Set(threeBikinis).size !== 3 ||
    threeBikinis[0] !== BIKINI_LOOKS[0] ||
    nextBikinis.some((look) => threeBikinis.includes(look))
  ) {
    throw new Error('auto bikini')
  }
  const police = pickCosplay('police', 3, () => 0)
  const nurse = pickCosplay('nurse', 1, () => 0)
  const costume = cosplayPrompt(police[0] ?? '')
  if (
    COSPLAY_THEMES.length !== 9 ||
    COSPLAY_THEMES.map((theme) => theme.label).join() !==
      'Police,Nurse,Teacher,Gym Girl,Flight Attendant,Fire Fighter,Cow Girl,Greek Mythos,Egyptian' ||
    police.length !== 3 ||
    new Set(police).size !== 3 ||
    nurse[0] !== COSPLAY_THEMES[1]?.costumes[0] ||
    COSPLAY_THEMES.some((theme) => theme.costumes.some((item) => asksForPoseChange(item))) ||
    !costume.includes(police[0] ?? 'missing') ||
    !costume.includes('Only the costume changes') ||
    !costume.includes('Drape the clothes over the bust') ||
    !costume.includes('Her chest size and shape stay exactly the same') ||
    !costume.includes('covers the chest and the stomach completely') ||
    !costume.includes('Do not compress, flatten, lift, bind, or shrink the chest') ||
    COSPLAY_THEMES.some((theme) => theme.costumes.some((item) => /\b(tight|fitted)\b/i.test(item))) ||
    !costume.includes('Do not change the pose') ||
    !costume.includes('The theme must be obvious at a glance') ||
    !costume.includes('Do not redraw the breasts') ||
    costume.includes('Remove the original outfit completely') ||
    costume.includes('no cleavage') ||
    !costume.includes('Costume dye must not move onto the skin') ||
    !costume.includes('A white costume does not lighten the skin') ||
    !costume.includes('does not make the chest smaller, flatter, rounder, or higher') ||
    COSPLAY_THEMES.some((theme) =>
      theme.costumes.some((item) => !/Chest and stomach stay covered/.test(item) || /sports bra|cropped|bare midriff|cleavage/i.test(item)),
    ) ||
    !COSPLAY_THEMES.every((theme) => {
      const mark: Record<string, RegExp> = {
        police: /badge/,
        nurse: /red cross/,
        teacher: /tartan|plaid/,
        gym: /headband/,
        flight: /wings pin/,
        fire: /reflective/,
        cow: /cowboy hat/,
        greek: /laurel wreath/,
        egyptian: /gold collar|gold-and-turquoise collar/,
      }
      const need = mark[theme.id]
      return need ? theme.costumes.every((item) => need.test(item)) : false
    })
  ) {
    throw new Error('cosplay')
  }
  if (
    matchCosplayTheme('Police') !== 'police' ||
    matchCosplayTheme('Cowgirl') !== 'cow' ||
    matchCosplayTheme('Fire Fighter') !== 'fire' ||
    matchCosplayTheme('Flight Attendant') !== 'flight' ||
    matchCosplayTheme('Gym Girl') !== 'gym' ||
    matchCosplayTheme('Greek Mythos') !== 'greek' ||
    matchCosplayTheme('') !== '' ||
    matchCosplayTheme('Beach') !== ''
  ) {
    throw new Error('cosplay theme match')
  }
  if (wornClothingPhoto([0, 0, 0, 255, 10, 10, 10, 255])) throw new Error('black cloth looked worn')
  const skin = [230, 180, 150, 255]
  if (!wornClothingPhoto(skin.concat(skin, skin, skin))) throw new Error('worn photo missed')
  console.log('dressEdit ok')
}
