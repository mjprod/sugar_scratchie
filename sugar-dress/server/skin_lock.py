"""Keep the source person's skin color, face, and torso width on every edit.

Skin is sampled from the face, so a garment cannot tint it. The torso is
widened only when the new chest is narrower and the pose still lines up.
Cap is 1.22. A 1.7 stretch ballooned shoulders, so that stays off.
The source face is pasted on when the head still lines up. A turn past
35 degrees, a bad scale, or a sloppy fit keeps the generated face.
ponytail: one similarity paste of the face oval. A profile that the
landmarker misses stays generated. Upgrade path is a posed face warp.
"""
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

FACE_PY = Path.home() / ".local/share/sugar-dress-face/bin/python"
FACE_SCRIPT = Path(__file__).with_name("face_landmarker.py")
EXTRACT = Path(__file__).with_name("extract_person.py")
MAX_BODY = 1.22


def channels(rgb):
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    chroma = np.hypot(cb - 128, cr - 128)
    return r, g, b, y, cb, cr, chroma


def skin_mask(rgb, chroma_lo, chroma_hi, red_gap=70):
    r, g, b, y, cb, cr, chroma = channels(rgb)
    return (
        (cr > cb + 2)
        & (chroma > chroma_lo)
        & (chroma < chroma_hi)
        & (y > 80)
        & (y < 235)
        & (g + 8 >= b)
        & ((r - g) > 8)
        & ((r - g) < red_gap)
    )


def median(values):
    if values.size == 0:
        return None
    return float(np.median(values))


def blur(mask, radius):
    """Separable box blur. ponytail: one pass, not a bilateral filter."""
    weight = mask.astype(np.float32)
    if radius < 1:
        return weight
    kernel = np.ones(radius * 2 + 1, np.float32)
    kernel /= kernel.sum()
    horizontal = np.apply_along_axis(lambda row: np.convolve(row, kernel, mode="same"), 1, weight)
    return np.apply_along_axis(lambda row: np.convolve(row, kernel, mode="same"), 0, horizontal)


def face_points(path):
    if not FACE_PY.is_file() or not FACE_SCRIPT.is_file():
        return []
    run = subprocess.run(
        [str(FACE_PY), str(FACE_SCRIPT), str(path)],
        capture_output=True,
        text=True,
    )
    if run.returncode != 0 or not run.stdout.strip():
        return []
    points = json.loads(run.stdout).get("points") or []
    return points if len(points) >= 8 else []


def face_box(path):
    points = face_points(path)
    if len(points) < 8:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def face_rect(points):
    if len(points) < 3:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    w, h = x1 - x0, y1 - y0
    if w < 8 or h < 8:
        return None
    return x0, y0, w, h


def face_similarity(src, dst):
    """Map src oval onto dst. x' = a x + c y + tx, y' = b x + d y + ty."""
    n = len(src)
    if n < 8 or n != len(dst):
        return None
    sx = sy = dx = dy = 0.0
    for s, d in zip(src, dst):
        sx += s[0]
        sy += s[1]
        dx += d[0]
        dy += d[1]
    sx /= n
    sy /= n
    dx /= n
    dy /= n
    spread = dot = cross = 0.0
    for s, d in zip(src, dst):
        x, y = s[0] - sx, s[1] - sy
        u, v = d[0] - dx, d[1] - dy
        spread += x * x + y * y
        dot += x * u + y * v
        cross += x * v - y * u
    if spread < 1:
        return None
    norm = float(np.hypot(dot, cross))
    if norm < 1e-3:
        return None
    scale = norm / spread
    cos = dot / norm
    sin = cross / norm
    a = scale * cos
    b = scale * sin
    c = -b
    d = a
    tx = dx - (a * sx + c * sy)
    ty = dy - (b * sx + d * sy)
    err = 0.0
    for s, p in zip(src, dst):
        err += float(np.hypot(a * s[0] + c * s[1] + tx - p[0], b * s[0] + d * s[1] + ty - p[1]))
    turn = abs(math.degrees(math.atan2(sin, cos)))
    return a, b, c, d, tx, ty, scale, turn, err / n


def paste_face(generated, reference, src_pts, dst_pts):
    """Strict face paste. A bad fit returns the generated picture unchanged."""
    h, w = generated.shape[:2]
    dst = face_rect(dst_pts)
    if dst is None or face_rect(src_pts) is None:
        return generated, "face kept"
    if dst[2] * dst[3] > w * h * 0.5:
        return generated, "face kept"
    fit = face_similarity(src_pts, dst_pts)
    if fit is None:
        return generated, "face kept"
    a, b, c, d, tx, ty, scale, turn, error = fit
    if not (0.35 <= scale <= 2.8 and turn <= 35 and error <= dst[3] * 0.12):
        return generated, "face kept"
    det = a * d - c * b
    if abs(det) < 1e-8:
        return generated, "face kept"
    coeffs = (
        d / det,
        -c / det,
        (-d * tx + c * ty) / det,
        -b / det,
        a / det,
        (b * tx - a * ty) / det,
    )
    warped = np.asarray(
        Image.fromarray(reference, mode="RGB").transform(
            (w, h), Image.AFFINE, coeffs, resample=Image.Resampling.BICUBIC
        )
    )
    cx = dst[0] + dst[2] / 2
    cy = dst[1] + dst[3] / 2
    grow = 1.04
    poly = [(cx + (p[0] - cx) * grow, cy + (p[1] - cy) * grow) for p in dst_pts]
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(1, round(dst[3] * 0.025))))
    px, py = int(round(cx)), int(round(cy))
    if px < 0 or py < 0 or px >= w or py >= h or mask.getpixel((px, py)) < 200:
        return generated, "face kept"
    alpha = np.asarray(mask).astype(np.float32)[:, :, None] / 255
    out = np.clip(np.rint(generated * (1 - alpha) + warped * alpha), 0, 255).astype(np.uint8)
    return out, "face pasted"


def sample_view(reference, face):
    h, w = reference.shape[:2]
    if face:
        x0, y0, x1, y1 = face
        dx = (x1 - x0) * 0.12
        dy = (y1 - y0) * 0.15
        xa = max(0, int(x0 + dx))
        xb = min(w, int(x1 - dx))
        ya = max(0, int(y0 + dy))
        yb = min(h, int(y1 - dy))
        if xb - xa >= 4 and yb - ya >= 4:
            return reference[ya:yb, xa:xb]
    return reference[: max(8, int(h * 0.22))]


def match_skin(generated, reference, face=None, person=None):
    # No silhouette means the room would be painted. Leave the picture alone.
    if person is None or person.shape[:2] != generated.shape[:2]:
        return generated, "kept generated"
    view = sample_view(reference, face)
    _, _, _, ref_y, ref_cb, ref_cr, _ = channels(view)
    ref_skin = skin_mask(view, 6, 52)
    if int(ref_skin.sum()) < 32:
        return generated, "kept generated"
    kept = ref_y[ref_skin]
    lo, hi = np.percentile(kept, [30, 75])
    mid = ref_skin & (ref_y >= lo) & (ref_y <= hi)
    if int(mid.sum()) < 32:
        mid = ref_skin
    target_y = median(ref_y[mid])
    target_cb = median(ref_cb[mid])
    target_cr = median(ref_cr[mid])
    ref_spread = float(np.std(ref_y[mid]))
    gen_r, gen_g, gen_b, gen_y, _, _, _ = channels(generated)
    hard = skin_mask(generated, 8, 58, red_gap=95)
    cloth = (gen_b > gen_g + 12) | ((gen_r - gen_g > 90) & (gen_g < 100))
    on_person = person > 32
    hard = hard & ~cloth & on_person
    if int(hard.sum()) < 32:
        return generated, "kept generated"
    weight = blur(hard, 2)
    weight = np.where(cloth | ~on_person, 0, weight)
    gen_spread = float(np.std(gen_y[hard]))
    scale = 1.0
    if ref_spread >= 4 and gen_spread >= 4:
        # The body is often much brighter than the face. Pull that gap down
        # to the source face, instead of keeping the generated wash-out.
        scale = min(1.0, max(0.35, ref_spread / gen_spread))
    mid_y = median(gen_y[hard])
    y = target_y + (gen_y - mid_y) * scale
    cb = np.full(y.shape, target_cb, np.float32)
    cr = np.full(y.shape, target_cr, np.float32)
    out_r = np.clip(np.rint(y + 1.402 * (cr - 128)), 0, 255)
    out_g = np.clip(np.rint(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)), 0, 255)
    out_b = np.clip(np.rint(y + 1.772 * (cb - 128)), 0, 255)
    mix = weight[:, :, None]
    painted = np.stack([out_r, out_g, out_b], axis=2)
    out = generated.astype(np.float32) * (1 - mix) + painted * mix
    return np.clip(np.rint(out), 0, 255).astype(np.uint8), "skin matched"


def bounds(person):
    ys, xs = np.nonzero(person > 16)
    if xs.size < 80:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def torso_chord(person, y, min_x, max_x):
    h, w = person.shape
    if y < 0 or y >= h:
        return None
    cx = (min_x + max_x) // 2
    row = person[y]
    if row[cx] <= 16:
        return None
    left = cx
    right = cx
    while left > 0 and row[left - 1] > 16:
        left -= 1
    while right < w - 1 and row[right + 1] > 16:
        right += 1
    if right - left < 4:
        return None
    return left, right


def band_width(person, box, y0, y1):
    widths = []
    for y in range(max(box[1], int(y0)), min(box[3], int(np.ceil(y1))) + 1):
        chord = torso_chord(person, y, box[0], box[2])
        if chord:
            widths.append(chord[1] - chord[0] + 1)
    if not widths:
        return None
    return max(widths)


def body_scale(src, dst):
    """How much to widen the generated chest. Never shrink. 1 means leave it."""
    left = bounds(src)
    right = bounds(dst)
    if not left or not right:
        return 1.0
    src_h = left[3] - left[1] + 1
    dst_h = right[3] - right[1] + 1
    if src_h < 8 or dst_h < 8 or abs(src_h - dst_h) / src_h > 0.2:
        return 1.0
    if abs((left[0] + left[2]) - (right[0] + right[2])) / 2 > src.shape[1] * 0.1:
        return 1.0
    src_bust = band_width(src, left, left[1] + src_h * 0.16, left[1] + src_h * 0.30)
    dst_bust = band_width(dst, right, right[1] + dst_h * 0.16, right[1] + dst_h * 0.30)
    if not src_bust or not dst_bust:
        return 1.0
    ratio = (src_bust / src_h) / (dst_bust / dst_h)
    if ratio < 1.06:
        return 1.0
    return min(ratio, MAX_BODY)


def fit_torso(rgb, matte, scale):
    if scale < 1.06:
        return rgb
    box = bounds(matte)
    if not box:
        return rgb
    h, w = matte.shape
    body_h = box[3] - box[1] + 1
    head = box[1] + body_h * 0.12
    waist = None
    for y in range(int(head + body_h * 0.34), int(head + body_h * 0.5) + 1):
        chord = torso_chord(matte, y, box[0], box[2])
        if chord and (waist is None or chord[1] - chord[0] < waist[1] - waist[0]):
            waist = chord
    if waist is None:
        return rgb
    column = waist[1] - waist[0] + 1
    cx = (waist[0] + waist[1]) / 2
    out = np.array(rgb, copy=True)
    y1 = min(h - 1, int(head + body_h * 0.32))
    for y in range(max(0, int(head + body_h * 0.14)), y1 + 1):
        t = (y - (head + body_h * 0.14)) / max(1, body_h * 0.08)
        if y > head + body_h * 0.22:
            t = ((head + body_h * 0.32) - y) / max(1, body_h * 0.1)
        gain = min(1.0, max(0.0, t))
        gain = gain * gain * (3 - 2 * gain)
        if gain < 0.02:
            continue
        local = 1 + (scale - 1) * gain
        new_half = column / 2 * local
        x0 = max(0, int(np.floor(cx - new_half)))
        x2 = min(w - 1, int(np.ceil(cx + new_half)))
        for x in range(x0, x2 + 1):
            src_x = cx + (x - cx) / local
            xa = max(0, min(w - 1, int(np.floor(src_x))))
            xb = max(0, min(w - 1, xa + 1))
            mix = min(1.0, max(0.0, src_x - xa))
            sample = rgb[y, xa] * (1 - mix) + rgb[y, xb] * mix
            edge = new_half - abs(x - cx)
            feather = max(0.0, min(1.0, edge / 2 if edge < 2 else 1.0))
            out[y, x] = np.round(sample * feather + rgb[y, x] * (1 - feather)).astype(np.uint8)
    return out


def person_matte(path):
    im = Image.open(path)
    w, h = im.size
    import tempfile

    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "matte.png"
        run = subprocess.run(
            [sys.executable, str(EXTRACT), str(path), str(out), "0", "0", str(w), str(h), "modnet"],
            capture_output=True,
            text=True,
        )
        if run.returncode != 0 or not out.is_file():
            return None
        matte = Image.open(out).convert("RGBA")
        if matte.size != (w, h):
            return None
        return np.asarray(matte)[:, :, 3]


def fit_body(generated, src_path, ref_path):
    try:
        src_matte = person_matte(ref_path)
        dst_matte = person_matte(src_path)
    except Exception:
        return generated, "body kept"
    if src_matte is None or dst_matte is None:
        return generated, "body kept"
    if dst_matte.shape[:2] != generated.shape[:2]:
        return generated, "body kept"
    scale = body_scale(src_matte, dst_matte)
    if scale < 1.06:
        return generated, "body kept"
    return fit_torso(generated, dst_matte, scale), f"body widened {scale:.2f}"


def fill_person(image):
    return np.full(image.shape[:2], 255, np.uint8)


def self_check():
    reference = np.zeros((24, 24, 3), np.uint8)
    reference[:, :] = (200, 160, 140)
    reference[0:6, :] = (230, 190, 165)
    generated = np.zeros((24, 24, 3), np.uint8)
    generated[:, :] = (230, 150, 110)
    generated[0:4, :] = (250, 210, 180)
    generated[20:24, 0:4] = (240, 110, 150)
    generated[20:24, 20:24] = (20, 40, 90)
    out, note = match_skin(generated, reference, (0, 0, 24, 24), fill_person(generated))
    if note != "skin matched":
        raise SystemExit(note)
    skin = out[12, 12].tolist()
    if abs(skin[0] - 200) > 12 or abs(skin[1] - 160) > 14:
        raise SystemExit(f"skin stayed tan {skin}")
    other = out[16, 16].tolist()
    if abs(other[0] - skin[0]) > 16:
        raise SystemExit(f"skin hues split {skin} {other}")
    if out[22, 2].tolist() != [240, 110, 150]:
        raise SystemExit(f"pink cloth moved {out[22, 2].tolist()}")
    if out[22, 22].tolist() != [20, 40, 90]:
        raise SystemExit(f"room moved {out[22, 22].tolist()}")
    plain = np.zeros((8, 8, 3), np.uint8)
    plain[2, 2] = (24, 36, 72)
    kept, kept_note = match_skin(plain, np.zeros((8, 8, 3), np.uint8))
    if kept_note != "kept generated" or not np.array_equal(kept, plain):
        raise SystemExit("empty skin rewrote the image")
    dressed = np.zeros((40, 40, 3), np.uint8)
    dressed[:16, :] = (200, 160, 140)
    dressed[16:, :] = (232, 214, 186)
    orange = np.full((40, 40, 3), (230, 150, 110), np.uint8)
    fixed, fixed_note = match_skin(orange, dressed, (2, 1, 38, 14), fill_person(orange))
    if fixed_note != "skin matched" or int(fixed[20, 20, 1]) > 175:
        raise SystemExit(f"clothes recolored the skin {fixed[20, 20].tolist()}")
    washed = np.zeros((32, 32, 3), np.uint8)
    washed[:12, :] = (200, 160, 140)
    washed[12:, :] = (240, 210, 200)
    source = np.full((32, 32, 3), (200, 160, 140), np.uint8)
    pulled, pulled_note = match_skin(washed, source, (0, 0, 32, 12), fill_person(washed))
    if pulled_note != "skin matched" or int(pulled[22, 16, 0]) > 215:
        raise SystemExit(f"bright body stayed pale {pulled[22, 16].tolist()}")
    room = np.full((24, 24, 3), (220, 180, 160), np.uint8)
    room[:, :12] = (230, 150, 110)
    only_body = np.zeros((24, 24), np.uint8)
    only_body[:, :12] = 255
    guarded, guarded_note = match_skin(room, reference, (0, 0, 24, 24), only_body)
    if guarded_note != "skin matched" or guarded[4, 18].tolist() != [220, 180, 160]:
        raise SystemExit(f"room was recolored {guarded[4, 18].tolist()}")

    def silhouette(bust_half):
        person = np.zeros((80, 60), np.uint8)
        person[8:18, 26:34] = 255
        person[18:28, 22:38] = 255
        person[28:46, 30 - bust_half : 30 + bust_half] = 255
        person[46:72, 24:36] = 255
        return person

    wide = silhouette(14)
    narrow = silhouette(8)
    scale = body_scale(wide, narrow)
    if scale < 1.06 or scale > MAX_BODY:
        raise SystemExit(f"body scale {scale}")
    if body_scale(wide, wide) != 1:
        raise SystemExit("matching torso was resized")
    rgb = np.full((80, 60, 3), 10, np.uint8)
    rgb[30, 24] = (255, 0, 0)
    rgb[10, 30] = (0, 255, 0)
    moved = fit_torso(rgb, narrow, scale)
    peak = int(np.argmax(moved[30, :, 0]))
    if peak >= 24:
        raise SystemExit(f"chest edge stayed {peak}")
    if moved[10, 30, 1] != 255:
        raise SystemExit("shoulder moved")

    def oval(x, y, w, h):
        return [
            [x, y],
            [x + w / 2, y],
            [x + w, y],
            [x + w, y + h / 2],
            [x + w, y + h],
            [x + w / 2, y + h],
            [x, y + h],
            [x, y + h / 2],
        ]

    reference = np.zeros((80, 80, 3), np.uint8)
    reference[:, :] = (0, 0, 255)
    reference[10:31, 10:31] = (255, 0, 0)
    generated_face = np.full((80, 80, 3), (0, 255, 0), np.uint8)
    src_pts = oval(10, 10, 20, 20)
    dst_pts = oval(30, 20, 20, 20)
    pasted, pasted_note = paste_face(generated_face, reference, src_pts, dst_pts)
    if pasted_note != "face pasted" or pasted[30, 40].tolist() != [255, 0, 0]:
        raise SystemExit(f"face paste missed {pasted_note} {pasted[30, 40].tolist()}")
    if pasted[0, 0].tolist() != [0, 255, 0]:
        raise SystemExit(f"face paste covered the corner {pasted[0, 0].tolist()}")
    spun = [[-p[1] + 40, p[0]] for p in src_pts]
    turned = face_similarity(src_pts, spun)
    if turned is None or turned[7] <= 35:
        raise SystemExit(f"turn not detected {turned}")
    kept_face, kept_note = paste_face(generated_face, reference, src_pts, spun)
    if kept_note != "face kept" or not np.array_equal(kept_face, generated_face):
        raise SystemExit(f"turned face was pasted {kept_note}")
    print("skin-lock self-check ok")


def main(argv):
    if "--self-check" in argv:
        self_check()
        return
    src, ref, dest = argv[1], argv[2], argv[3]
    generated = np.asarray(Image.open(src).convert("RGB"))
    try:
        reference = np.asarray(Image.open(ref).convert("RGB"))
        src_matte = person_matte(ref)
        dst_matte = person_matte(src)
        if (
            src_matte is not None
            and dst_matte is not None
            and dst_matte.shape[:2] == generated.shape[:2]
        ):
            scale = body_scale(src_matte, dst_matte)
            fitted = fit_torso(generated, dst_matte, scale) if scale >= 1.06 else generated
            body_note = f"body widened {scale:.2f}" if scale >= 1.06 else "body kept"
        else:
            fitted, body_note = generated, "body kept"
        pasted, face_note = paste_face(fitted, reference, face_points(ref), face_points(src))
        out, note = pasted, f"{body_note}; {face_note}; skin kept"
    except Exception as err:
        out, note = generated, f"kept generated ({err})"
    Image.fromarray(out, mode="RGB").save(dest)
    print(note, flush=True)


if __name__ == "__main__":
    main(sys.argv)
