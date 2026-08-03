# Video Transition Playground

Desktop-first lab at **`/video-transition`** to design A → B video transitions, capture keyframes, and **copy JSON to paste back here**. Not wired into the real game yet.

## Confirmed requirements

| Choice | Decision |
|--------|----------|
| Layout | Desktop side debug panel (always visible) |
| Layers | Independent **A (out)** + **B (in)** |
| Props | **x, y, blur, scale, opacity** per layer |
| Sources | Card **bottom** videos only (`/cards/index.json`) |
| Timeline | Scrub + play; **linear** interp between keyframes |
| Source videos | **Loop independently** (transition clock ≠ video time) |
| Export | Keyframe JSON for pasting to me (design lab, not production player yet) |

## Files

| Change | File |
|--------|------|
| New page | `src/VideoTransitionPlayground.tsx` |
| Route | `src/main.tsx` — `if (path === "/video-transition") return VideoTransitionPlayground` |
| Styles | `src/styles.css` — `.transition-lab-*` desktop grid |
| Optional | Dashboard link “Transition lab” |

No backend changes. Reuse `loadVideoSrc` / `releaseMediaElement` from `src/shared/media.ts`.

## Desktop layout

```
┌─────────────────────────────┬──────────────────────────┐
│  Stage (390×672, centered)  │  Debug panel (~380px)    │
│  B under, A over            │  Card A / B selects      │
│                             │  Duration, play controls │
│  Timeline + scrubber        │  Layer A sliders         │
│  ▶  ●──◆──◆──  t / duration │  Layer B sliders         │
│                             │  Keyframe list + Copy    │
└─────────────────────────────┴──────────────────────────┘
```

- CSS grid: `1fr | 380px`, full viewport height
- Panel always on the right — no mobile collapse
- Stage letterboxes product frame 390×672

## Panel controls

**Sources:** Card A / Card B selects from cards index; block same card twice; reload

**Transport:** durationMs (default 1000), Play / Pause / Stop, playhead readout

**Per layer (A and B):**
- `x` −200…200 px  
- `y` −200…200 px  
- `scale` 0…2 (default 1)  
- `blur` 0…40 px  
- `opacity` 0…1 (default 1)

**Keyframes:** list by `t`, Add @ playhead / Update selected / Delete, click to jump  
**Copy JSON** → clipboard · **Import JSON** textarea · **Reset defaults**

## Stage behavior

- Two looping `<video muted playsInline>` elements, loaded via `loadVideoSrc` when selection changes
- Pose applied on wrappers: `transform: translate(x,y) scale(s)`, `filter: blur(Npx)`, `opacity`
- Timeline scrubber 0→1 with keyframe markers; rAF advances playhead while playing
- Default cards: first two distinct entries with a valid `bottom`

## Interaction

1. Sliders edit working pose at playhead  
2. Add keyframe stores A+B at `t` (ε≈0.01 near existing → update)  
3. Scrub samples linear interp into pose + sliders  
4. Play runs `t` current → 1  
5. Card change keeps keyframes; export records new ids  

## Copy payload

```ts
type LayerProps = {
  x: number;
  y: number;
  scale: number;
  blur: number;
  opacity: number;
};

type TransitionKeyframe = {
  t: number; // 0..1
  a: LayerProps;
  b: LayerProps;
};

type TransitionPreset = {
  version: 1;
  durationMs: number;
  cardAId: string;
  cardBId: string;
  keyframes: TransitionKeyframe[];
};
```

Default seed: keyframes at `t=0` and `t=1` (A identity → exit; B enters → identity) so something visible works immediately.

Linear lerp per property between sorted keyframes. JSON is pretty-printed for easy paste-back.

## Out of scope

- In-game card switch integration  
- Easing curves / wipes / masks (add later if needed)  
- Foreground / trailer / intro sources  
- Mobile layout  

## Verify

1. `npm run dev` → `/video-transition`  
2. Side panel + two different bottoms looping  
3. Keyframes, scrub, play interpolate all 5 props on A and B  
4. Copy → import restores preset  
5. `npm run build` typechecks clean  

## Success criteria

- Desktop side debug panel always available  
- Dual-layer x/y/blur/scale/opacity  
- Timeline + linear keyframes + copyable JSON for iteration with me