/**
 * High-fidelity photo assets for Sugar Scratch v8 prototype.
 * Spec 8 holographic pack art (local) for carousel / collection / splash.
 */

/** Spec 8 holographic / revealed pack covers */
export const HOLO_PACKS = {
  cyberHolo: "/images/packs/cyber-holo.webp",
  cyberRevealed: "/images/packs/cyber-revealed.webp",
  kimonoHolo: "/images/packs/kimono-holo.webp",
  kimonoRevealed: "/images/packs/kimono-revealed.webp",
  idolHolo: "/images/packs/idol-holo.webp",
  idolRevealed: "/images/packs/idol-revealed.webp",
  nurseHolo: "/images/packs/nurse-holo.webp",
  studentHolo: "/images/packs/student-holo.webp",
  mageHolo: "/images/packs/mage-holo.webp",
  cafeHolo: "/images/packs/cafe-holo.webp",
  racingHolo: "/images/packs/racing-holo.webp",
  samuraiHolo: "/images/packs/samurai-holo.webp",
  winterHolo: "/images/packs/winter-holo.webp",
} as const;

export const CREATOR_PHOTOS = {
  emma: {
    avatar: HOLO_PACKS.cyberRevealed,
    portrait: HOLO_PACKS.cyberHolo,
  },
  nancy: {
    avatar: HOLO_PACKS.kimonoRevealed,
    portrait: HOLO_PACKS.kimonoHolo,
  },
  alex: {
    avatar: HOLO_PACKS.idolRevealed,
    portrait: HOLO_PACKS.idolHolo,
  },
  sam: {
    avatar: HOLO_PACKS.nurseHolo,
    portrait: HOLO_PACKS.racingHolo,
  },
} as const;

/** Pack cover art — holographic Spec 8 assets */
export const PACK_PHOTOS: Record<string, string> = {
  ep1: HOLO_PACKS.cyberHolo,
  ep2: HOLO_PACKS.cyberRevealed,
  ep3: HOLO_PACKS.kimonoHolo,
  en1: HOLO_PACKS.kimonoRevealed,
  en2: HOLO_PACKS.idolHolo,
  eb1: HOLO_PACKS.idolRevealed,
  eb2: HOLO_PACKS.nurseHolo,
  em1: HOLO_PACKS.studentHolo,
  nl1: HOLO_PACKS.mageHolo,
  nl2: HOLO_PACKS.cafeHolo,
  np1: HOLO_PACKS.racingHolo,
  al1: HOLO_PACKS.samuraiHolo,
  al2: HOLO_PACKS.winterHolo,
  aa1: HOLO_PACKS.idolHolo,
  sw1: HOLO_PACKS.kimonoHolo,
};

export const SPLASH_PHOTOS = [
  HOLO_PACKS.cyberHolo,
  HOLO_PACKS.samuraiHolo,
  HOLO_PACKS.racingHolo,
] as const;

/** Full creator card art (photo + chrome) from FigJam reference */
export const CREATOR_CARD_PHOTOS = {
  juliana: "/images/cards/juliana-card.png",
} as const;

/** Theme pack covers only (no personal/main avatars). */
export const MODEL_PACK_PHOTOS = {
  julianaFiregirl: "/images/cards/themes/juliana-firegirl.jpg",
  julianaGym: "/images/cards/themes/juliana-gym.jpg",
  julianaNurse: "/images/cards/themes/juliana-nurse.jpg",
  julianaPolice: "/images/cards/themes/juliana-police.jpg",
  julianaTeacher: "/images/cards/themes/juliana-teacher.jpg",
} as const;

export const PREFERENCE_PHOTOS = [
  CREATOR_CARD_PHOTOS.juliana,
  HOLO_PACKS.kimonoHolo,
  HOLO_PACKS.idolHolo,
  HOLO_PACKS.nurseHolo,
  HOLO_PACKS.studentHolo,
  HOLO_PACKS.mageHolo,
  HOLO_PACKS.racingHolo,
  HOLO_PACKS.samuraiHolo,
] as const;

/** Foil pack faces are often MP4 (`packFaceVideoUrl`). */
export function isProbablyVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url.trim());
}

/**
 * Inventory tile cover. Prefer the stored URL, including API pack-face videos.
 * Local stills are only a fallback when no cover was persisted.
 */
export function resolveInventoryCoverUrl(input: {
  coverUrl?: string | null;
  packId?: string | null;
  themeName?: string | null;
  creator?: string | null;
}): string {
  const raw = input.coverUrl?.trim() ?? "";
  if (raw) return raw;

  const packId = input.packId?.trim() ?? "";
  if (packId && PACK_PHOTOS[packId]) return PACK_PHOTOS[packId];

  const theme = (input.themeName ?? "").toLowerCase();
  const creator = (input.creator ?? "").toLowerCase();
  if (creator.includes("juliana") || theme.includes("juliana")) {
    if (/fire|pack\s*1/.test(theme)) return MODEL_PACK_PHOTOS.julianaFiregirl;
    if (/gym|pack\s*2/.test(theme)) return MODEL_PACK_PHOTOS.julianaGym;
    if (/nurse|pack\s*3/.test(theme)) return MODEL_PACK_PHOTOS.julianaNurse;
    if (/police|pack\s*4/.test(theme)) return MODEL_PACK_PHOTOS.julianaPolice;
    if (/teach|pack\s*5/.test(theme)) return MODEL_PACK_PHOTOS.julianaTeacher;
    return CREATOR_CARD_PHOTOS.juliana;
  }

  return HOLO_PACKS.cyberHolo;
}

