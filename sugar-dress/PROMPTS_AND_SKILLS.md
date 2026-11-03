# Sugar Dress — Prompts & Skills Reference

Exact prompts and post-processing skills used for upload → edit flows (POSING / redress / clothes change). Source of truth: `src/lib/dressEdit.ts`, `src/components/InfiniteCanvas.tsx`, `server/xaiImagineApi.ts`.

UI names map as:

| User-facing | Code |
|---|---|
| POSING (repose) | `runPose` → `dressEditPrompt({ poseIndex: 1, lockFace: true })` |
| Regenerate / Clothes On (redress) | `runDress` / PromptBar → `dressEditPrompt` |
| Upload | No generation prompt; image is only a reference until an edit runs |

---

## Shared background suffix (“ground”)

Appended by `InfiniteCanvas` to POSING, dress, auto bikini, and cosplay prompts.

**Opaque scene (photo still has a room):**

```
Keep the background exactly as in the first image. Do not replace the room.
```

**Cutout / white around person:**

```
The white around the person is empty. Do not add a background.
```

---

## 1. POSING (repose) — `runPose`

**Images:** person (flattened on white) + `/pose-default.png`  
**API flags:** `pose_index: 1`  
**Server:** pose ref → gray silhouette via `posePlate` (`server/pose_plate.py`)  
**Prompt builder:** `dressEditPrompt({ userPrompt: '', apiPrompt: '', clothingIndex: null, poseIndex: 1, lockFace: true })` + ground

### Exact prompt body

```
Change the pose of the person in the first image. Do not keep the original arm position. Both arms hang down at the sides, away from the waist. The hands come off the hips and hang open beside the thighs. The torso stays upright. Move every strand of hair that hangs in front of the body behind the back. Hair must not lie on the chest, stomach, shoulders, or arms. The front of the body stays clear of hair. Do not change the hair color or length.
the second image is a pose and action reference only. It is a flat gray silhouette, not a photo of a dressed person. Match that silhouette's body only: limb angles, hand position, and torso lean. Do not turn, replace, or redraw the face. The hair is separate from the face. The face in the first image stays the same person: same eyes, nose, mouth, jaw, and expression. the second image contributes no face and no clothing. Put every strand of hair that hangs in front of the body behind the character. Hair must not lie on the chest, stomach, shoulders, or arms. Sweep it behind the back. Do not leave the hair in front. Do not change the hair color or length.
Keep the same face, expression, skin color, skin sheen, and background. Keep this person's chest, waist, hips, and shoulders at the same size and shape. The arms and hands keep the same length and thickness, but their angles follow the pose reference. Move the arms, hands, and torso so they match the pose reference. Do not leave them in the original pose. Do not melt the joints or add extra limbs. Put every strand of hair that hangs in front of the body behind the character. Do not leave the hair in front. The bust volume and shape stay as they are under the clothes. Do not cut the neckline open to expose it. Do not compress, flatten, bind, or shrink it. The clothes fit the body. The body does not change to fit the clothes. Do not brighten, darken, tan, or gloss the skin.
```

Then + ground (see above).

---

## 2. Redress / clothes change — `dressEditPrompt`

Used by:

- Quick PromptBar (`PromptBar.tsx` → `dressEditPrompt`)
- Image menu Regenerate → Run (`runDress`)
- Detail panel / Clothes On chain (`runDress`)

Core function: `src/lib/dressEdit.ts` → `dressEditPrompt`.

Ordinals: image 0 = `the first image`, 1 = `the second image`, etc. (`imagePhrase`).

### A. Clothes reference image present (`clothingIndex` set)

```
Change the outfit of the person in {person} to the clothes in {cloth}. Copy that outfit exactly: the same pieces, colors, sleeves, collar, length, and hardware. Do not design a different outfit. Keep its neckline, collar, shoulder coverage, badges, and sleeves. Do not lower the neckline, bare the shoulders, or remove a collar, badge, or sleeve. Remove the original outfit completely, including every edge, strap, lace, and seam. Do not keep the original bare shoulders. Do not recolor the old garment in place. {cloth} is clothing, not a body. Do not copy a chest, waist, or height from it, even when the clothes are a dress, a shirt, or a full outfit that covers the chest. Her chest size and shape stay the ones in {person}. A smaller or tighter garment does not reduce her chest. The chest outline stays the same shape as the first image. Drape the clothes over the bust that is already there.
```

Optional: user’s text prompt as its own line.

### B. Text-only clothes (no clothing image, prompt has non-pose words)

```
Change the outfit of the person in {person} to: {words}. Remove the original outfit completely, including every edge, strap, lace, and seam. Do not recolor the old garment in place. A full outfit, dress, or shirt does not change her chest size, chest shape, waist, or hips. Those stay as they are in {person}.
```

### C. Undress (`undress: true` / `runDress(..., bare = true)`)

```
Remove the outfit from the person in {person}. Erase every edge, strap, lace, and seam. Do not recolor the old garment in place.
Where the fabric was, continue this person's skin. Smooth over the nipples and the genital area: no nipple, no areola, no genital shape, no crease, and no leftover outline.
Keep the same face, pose, chest size, height, and shape, skin color, and background. Do not brighten or darken the skin.
```

(Undress returns early — no pose/lock branches below.)

### Pose lines (after clothes lines, when not undressing)

**Pose reference attached** (`poseIndex` set, `lockFace: false`):

```
{pose} is a pose and action reference only. It is a flat gray silhouette, not a photo of a dressed person. Match that silhouette's pose and action: limb angles, hand position, torso lean, and head angle. The gray is not clothing, not a face, and not an outfit. Do not copy clothes, accessories, colors, or identity from it. {pose} contributes no clothing.
```

**Pose words in user prompt, no pose image:**

```
Apply only the pose change written above.
```

**Otherwise:**

```
Do not change the pose.
```

### Lock line (default, no `lockFace`)

```
Keep the same face, expression, skin color, skin sheen, neck, and background. Keep this person's chest, waist, hips, shoulders, arms, and hands at the same size and shape. Do not redraw the neck, arms, or hands. The bust volume and shape stay as they are under the clothes. Do not cut the neckline open to expose it. Do not compress, flatten, bind, or shrink it. The clothes fit the body. The body does not change to fit the clothes. Do not brighten, darken, tan, or gloss the skin.
```

### Pose keyword detector (`asksForPoseChange`)

Regex source:

```
換動作|改動作|換姿勢|改姿勢|換姿態|姿勢|姿態|\bpose\b|舉手|轉身|躺下|蹲下|跳躍|跳舞|坐下|站著|走路|跑步|standing|sitting|walking|running
```

---

## 3. Background change — `backgroundPrompt`

```
Paint this location behind the person in the first image: {words}
```
(or `Paint a new location behind the person in the first image.` if empty)

```
The white around the person is empty. It must be completely replaced. Do not restore any earlier room.
Match this person: same camera angle, same scale, and the feet meet the ground, as one photograph.
Do not relight, recolor, brighten, darken, or move the person. Their light stays exactly as in the first image.
No other people, no faces, no text.
```

If a place reference image is attached:

```
The second image is the location to paint. Use that place. Do not copy its people, and do not copy its light onto the person.
```

---

## 4. Build Dress — garment-only catalog

### `buildDressPrompt` (`BuildDressPanel.tsx`)

```
Catalog product photo of one outfit, front-facing, centered, from the neckline to the knee. Nothing below the knee. Seamless light gray studio background. Invisible mannequin: the clothes hold a worn shape, but there is no person, no head, no face, no hair, and no visible skin. The neck opening is empty. Clothing only. No legs, no hands, no shoes, no socks, and no boots. Sleeves end empty. Do not draw a real model. Do not lay the clothes flat on white. Build only the outfit described below. Do not invent a different garment. Style it as current K-pop idol fashion: polished, coordinated, and stage-ready. {user text}
```

### `fittedDressPrompt` (`buildDressFit.ts`) — body-fitted variant

```
The first image is one person. Use it only for body size and shape. Do not copy the clothes, colors, or outfit in that photo. Build only this outfit: {words}. Do not invent a different garment. Style it as current K-pop idol fashion: polished, coordinated, and stage-ready. Catalog product photo of that outfit, front-facing, centered, from the neckline to the knee. Nothing below the knee. Seamless light gray studio background. Invisible mannequin: the clothes hold a worn shape, but there is no person, no head, no face, no hair, and no visible skin. The neck opening is empty. Clothing only. No legs, no hands, no shoes, no socks, and no boots. Sleeves end empty. Do not draw a real model. Do not lay the clothes flat on white. The garment width must match this person's shoulder, bust, waist, and hip width. Do not use a standard model size. Do not make the garment wider or narrower than this body.
```

---

## 5. Outfit Change panel — flat-lay garment invent

`OutfitPanel.tsx` → `makeGarment`:

```
Flat-lay product photo of {tops|bottoms|one-pieces} on a plain white background. No person, no mannequin, no face, no text. {prompt}
```

Try-on then goes through FASHN / Leffa APIs (`/api/fashn-tryon`, `/api/leffa-tryon`) with person + garment images (not `dressEditPrompt`).

---

## 6. Auto Bikini — `autoBikiniPrompt`

Wraps `dressEditPrompt` with:

```
Replace only the clothes with this exact look: {look}. Keep this color and this cut. Do not substitute a different bikini or a plain black lace set. It must stay a sexy bikini, sexy lace lingerie, or erotic lingerie.
```

Plus:

```
No regular clothes. No dress, shirt, skirt, jacket, coat, or trousers. A teddy, garter set, corset, babydoll, fishnet bodysuit, or harness is erotic lingerie.
The face, neck, skin color, skin sheen, chest, waist, shoulders, legs, arms, and hands stay identical to the first image. Do not redraw them. Do not tan, pale, gloss, or recolor the skin. Only the clothes change.
```

Then + ground. Looks are built from `BIKINI_COLORS` × `BIKINI_CUTS` in `dressEdit.ts`.

---

## 7. Cosplay — `cosplayPrompt`

Wraps `dressEditPrompt` with a long costume lock (skin + bust + signature pieces), then:

```
The face, neck, skin color, skin sheen, chest, waist, shoulders, legs, arms, and hands stay identical to the first image. Do not redraw them. Do not tan, pale, gloss, or recolor the skin. Costume dye must not move onto the skin. Do not redraw the breasts. The chest size and shape stay exactly as they are in the first image, including under a shirt, vest, jacket, or dress. Do not compress, flatten, lift, bind, or shrink the chest. Only the costume changes.
```

Then + ground. Themes: Police, Nurse, Teacher, Gym Girl, Flight Attendant, Fire Fighter, Cow Girl, Greek Mythos, Egyptian (`COSPLAY_THEMES`).

---

## 8. Policy append (relays)

`server/xaiImagineApi.ts` / `FICTIONAL_PERSON_GUARD` in `genProvider.ts`.

Appended when provider is **not** `flux-18` and the prompt matches `真人|celebrity|real person|photoreal` (and doesn’t already include “Fictional stylized”):

```
Fictional stylized characters only for a commercial storyboard — not real celebrities, not photoreal identifiable real people.
```

---

## Skills & post-processors

These run **after** (or before) generation. They are not LLM prompt text.

### Automatic on every `/api/generate-image` with a person reference

| Step | Module | What it does |
|---|---|---|
| Garment prep | `server/garment_sample.py` via `garmentSample` | When `clothing_index` is set: keep clothing ref as-is before the model |
| Pose prep | `server/pose_plate.py` via `posePlate` | When `pose_index` is set: replace pose photo with a flat gray silhouette |
| **Skin lock** | `server/skin_lock.py` via `lockReferenceSkin` | Match result skin to source person (face-sampled); may paste source face; may widen torso up to 1.22×. Clothes left alone |

Skin tone is enforced both **in-prompt** (“skin color / skin sheen… Do not brighten, darken, tan, or gloss”) and **post-gen** by skin-lock.

### Optional (client must send the field)

| Field | Module | What it does |
|---|---|---|
| `color_match` | **grade-images skill** via `server/skin_match.py` / `matchReferenceColour` | Whole-image colour grade toward a reference |
| `body_match` | `server/body_match.py` / `matchReferenceBody` | Fit person box to a body reference after gen |

### External skill: grade-images (skin / colour)

- Install path: `~/.local/share/mxj-grade-images/skills/grade-images`
- Override: `GRADE_SKILL` env
- Python: Klein venv (`GRADE_PYTHON` / `FLUX3_KLEIN_PYTHON` / `~/.local/share/mxj-flux3-klein/venv/bin/python`)
- Scripts used: `scripts/match.py`, `scripts/grade.py`
- Recipe: `assets/recipes/neutral-correction.json`
- Wrapper params in `skin_match.py`: strength `0.65`, `skin_protection=False`, stats max 1600px
- **Not** on the default POSING/redress path unless the client sends `color_match`

### Face landmarker (skin-lock helper)

- Used inside `skin_lock.py` for face oval paste
- Python: `~/.local/share/sugar-dress-face/bin/python`
- Script: `server/face_landmarker.py`

---

## File map

| Concern | File |
|---|---|
| Main edit / pose / undress / bikini / cosplay / background prompts | `src/lib/dressEdit.ts` |
| POSING + dress runners + ground lines | `src/components/InfiniteCanvas.tsx` |
| Quick bar assembly | `src/components/PromptBar.tsx` |
| Build Dress prompt | `src/components/BuildDressPanel.tsx`, `src/lib/buildDressFit.ts` |
| Outfit flat-lay + FASHN/Leffa | `src/components/OutfitPanel.tsx` |
| Generate API + skin lock / grade / body | `server/xaiImagineApi.ts` |
| Skin lock | `server/skinLock.ts`, `server/skin_lock.py` |
| Colour grade skill bridge | `server/gradeMatch.ts`, `server/skin_match.py` |
| Body match | `server/bodyMatch.ts`, `server/body_match.py` |
| Pose silhouette | `server/garmentSample.ts` → `posePlate`, `server/pose_plate.py` |
| Policy string | `src/lib/genProvider.ts` (`FICTIONAL_PERSON_GUARD`) |
