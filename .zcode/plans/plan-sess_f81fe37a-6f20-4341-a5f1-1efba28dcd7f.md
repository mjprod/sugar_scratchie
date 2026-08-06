# Gold Hex CTA Template

Add a second shape-capable CTA preset that matches the pointed “OPEN PACK” badge geometry, reusing the existing Aurora + particles + BorderGlow stack with a gold palette, plus a title + cost content row.

## Goals
- New template in the button lab (`/button-test`) selectable next to Squircle CTA
- **Pointed hexagon / horizontal chevron** outline via CSS `clip-path: shape(...)`
- **Fixed hex proportions** (tip depth baked in; width/height remain free)
- **Gold aurora palette** (not a new fill engine)
- **Title + optional cost row** (`OPEN PACK` / `10` + diamond)

## Non-goals
- Game integration outside the lab
- Static metallic bevel system (user chose aurora stack)
- Tunable tip-depth slider (user chose fixed proportions)
- Freeform `children` API

## Shape design

Reference silhouette: elongated capsule with **left/right pointed tips** and soft vertices (not a tall regular hexagon).

### Geometry model
Keep the stroke-ring architecture:
```
BorderGlow (bare)
└── button.cta-button.cta-button--hex   // outer shape, stroke color fill
    └── .cta-button__inner              // inset stroke; concentric hex
        ├── aurora
        ├── face veil
        └── label stack (title + cost)
```

Add a shape variant on `CtaButton`:
- `shape?: "squircle" | "hex"` (default `"squircle"`)

CSS classes:
- `.cta-button--squircle` — existing rounded-rect `shape()`
- `.cta-button--hex` — pointed hex `shape()`

### Fixed hex path (parameterized only by box + vertex radius)
Use CSS vars:
- `--cta-w`, `--cta-h` (existing)
- `--cta-r` / `--cta-inner-r` (vertex rounding; still useful even with fixed tip depth)
- `--cta-tip` = fixed fraction of height, e.g. `calc(var(--cta-h) * 0.42)` (tune once to match mock)

Outer path concept (clockwise):
```
from tipL.x, 50%
→ upper-left soft corner
→ top edge
→ upper-right soft corner
→ tipR
→ lower-right soft corner
→ bottom edge
→ lower-left soft corner
→ close at tipL
```

Implement with `clip-path: shape(...)` using `line`/`hline`/`vline` + `arc` at the six vertices. Mirror the same path on `__inner` with:
- `inset: var(--cta-stroke)`
- slightly reduced tip + radius so the ring stays even (`--cta-inner-tip`, `--cta-inner-r`)

Because tip depth is fixed, hide or de-emphasize “Corner radius” impact for hex only if needed; keep the slider (it still softens vertices). No new tip slider in the lab.

### BorderGlow note
Glow remains rectangular under the hood; bare mode already depends on the CTA clip + opaque inner plate so the mesh only shows in the stroke band. Accept that outer bloom is rect-ish (same as squircle). No BorderGlow rewrite unless the ring looks broken after first paint.

## Content API (title + cost)

Extend `CtaButtonProps` / template values:

```ts
label?: string;            // primary, e.g. "OPEN PACK"
costAmount?: string | number | null;  // e.g. 10; null/undefined hides row
costIcon?: string;         // default "💎" (or a small inline SVG later)
```

Label markup:
```tsx
<span className="cta-button__label">
  <span className="cta-button__title">{label}</span>
  {costAmount != null && costAmount !== "" ? (
    <span className="cta-button__cost">
      <span className="cta-button__cost-amount">{costAmount}</span>
      <span className="cta-button__cost-icon" aria-hidden>{costIcon}</span>
    </span>
  ) : null}
</span>
```

CSS:
- Stack vertically, centered
- Title: uppercase tracking, slightly smaller letter-spacing than mock if needed
- Cost: larger/bolder number + icon gap
- Keep existing text-shadow / non-select rules
- Slightly tighter vertical padding for hex height

Accessibility: button accessible name should include cost when present (e.g. `aria-label={`${label}, ${costAmount}`}` or rely on visible text). Prefer visible text composition so SR reads both lines.

## Gold template preset

In `src/components/ctaTemplates.ts`:

1. Extend `CtaTemplateId` with `"hexGoldCTA"` (or `"openPackCTA"`).
2. Extend `CtaTemplateValues` with:
   - `shape: "squircle" | "hex"`
   - `costAmount: string` (empty string = hidden)
   - `costIcon: string`
3. Add `HEX_GOLD_CTA` preset roughly:
   - `shape: "hex"`
   - `label: "OPEN PACK"`
   - `costAmount: "10"`, `costIcon: "💎"`
   - size near mock proportions (start ~`width: 320–360`, `height: 72–88`, then tune in lab)
   - `cornerRadius`: modest vertex soften (e.g. 10–14)
   - gold aurora stops: deep bronze → bright gold → amber → dark bronze
   - `auroraBaseColor`: dark bronze plate
   - particles: light gold / soft white-gold
   - `labelColor`: warm off-white / pale gold
   - glow HSL ~`"40 90 50"` + gold mesh colors
   - keep glow always-on like squircle
4. Register in `CTA_TEMPLATES`. Leave `DEFAULT_CTA_TEMPLATE_ID` as squircle unless you prefer the new one while authoring.

## File changes

| File | Change |
|------|--------|
| `src/components/CtaButton.tsx` | `shape`, `costAmount`, `costIcon`; class `cta-button--${shape}`; label stack; pass-through unchanged aurora/glow |
| `src/components/ctaTemplates.ts` | new id + values fields + `HEX_GOLD_CTA` |
| `src/styles.css` | hex clip-path variants for outer/inner; title/cost label styles |
| `src/ButtonTestPage.tsx` | wire `shape` (from template; optional read-only display), cost text/icon fields, include new keys in copy snippets |

Lab UX:
- Template dropdown switches to Hex Gold and loads values
- Add small **Content** controls: cost amount text + cost icon text
- Shape comes from template (no need for a free shape picker unless cheap to add)
- Existing size/aurora/particle/glow sliders still apply

## Implementation steps
1. **CSS first**: extract current clip into `.cta-button--squircle` / `__inner` equivalent; add `--hex` paths with fixed tip ratio; verify stroke ring concentricity at a few sizes.
2. **CtaButton API**: add `shape` + cost props and label structure; default shape squircle so existing usage stays identical.
3. **Template registry**: add gold hex preset with first-pass gold colors and OPEN PACK content.
4. **Lab wiring**: template select + cost fields + copy helpers include new keys.
5. **Tune in browser** at `/button-test`: tip ratio, height, gold stops, particle density, label hierarchy until it reads like the mock.
6. **`npm run build`** (tsc strict) as the correctness gate.

## Verification
- `/button-test`: both templates render; switching resets values
- Hex silhouette matches pointed badge (left/right tips, soft corners)
- Stroke ring follows hex, not rect
- Cost row hides when amount empty; shows `10 💎` on preset
- Hover/press/disabled still work
- Glow/particles visible on gold preset
- Build passes

## Risks / watchouts
- **`clip-path: shape()` support** — already required by squircle; hex is same family
- **Inner concentric hex** — tip + radius must shrink with stroke or ring thickness will uneven at points
- **Label overflow** on short widths — constrain font sizes / allow wrap only if necessary; mock is single-line title
- **Emoji diamond** may differ by platform; acceptable for prototype (SVG icon later if needed)
