"""Combine a face recording (e.g. Zoom, with its touch-up) and a screen recording (Studio Recorder)
into side-by-side / screen + face / face-only layouts, as a 16:9 video or a 9:16 Reel/Short.

The two files are synced automatically by matching their audio (a clap at the start helps),
the face video's black bars are trimmed, and the face is located with OpenCV's YuNet detector so
the face crop is framed on you. Rendering is a single ffmpeg filter graph.
"""
import re
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

APP_DIR = Path(__file__).resolve().parent
YUNET = APP_DIR / "vendor" / "models" / "face_detection_yunet.onnx"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
BG = "0x10131a"


def ffmpeg_exe():
    import shutil
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


FF = ffmpeg_exe()


def run(args, **kw):
    return subprocess.run([FF, "-hide_banner", *args], capture_output=True, creationflags=NO_WINDOW, **kw)


def probe(path):
    err = run(["-i", str(path)]).stderr.decode("utf-8", "replace")
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    v = re.search(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})", err)
    if not d or not v:
        raise ValueError(f"not a readable video: {path}")
    return {
        "duration": int(d[1]) * 3600 + int(d[2]) * 60 + float(d[3]),
        "width": int(v[1]), "height": int(v[2]),
        "audio": "Audio:" in err,
    }


# ---------------------------------------------------------------- analysis
def content_box(path, info):
    """Picture area without black bars (Zoom letterboxes the camera inside a wider canvas)."""
    boxes = []
    for frac in (0.25, 0.5, 0.75):
        t = info["duration"] * frac
        err = run(["-ss", f"{t:.2f}", "-t", "2", "-i", str(path), "-vf", "cropdetect=24:2:0", "-an", "-f", "null", "-"]).stderr.decode()
        found = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", err)
        if found:
            boxes.append(tuple(map(int, found[-1])))
    if not boxes:
        return [0, 0, info["width"], info["height"]]
    w, h, x, y = max(set(boxes), key=boxes.count)
    return [x, y, w, h]


def screen_content_box(path, info, samples=6):
    """Area actually used by the screen in a screen recording: trims dark padding (e.g. a recording made
    with a layout whose face panel was empty). Union over several moments so dark app content is kept."""
    boxes = []
    for i in range(samples):
        t = info["duration"] * (0.1 + 0.8 * i / max(1, samples - 1))
        err = run(["-ss", f"{t:.2f}", "-t", "1.5", "-i", str(path), "-vf", "cropdetect=44:2:0", "-an", "-f", "null", "-"]).stderr.decode()
        found = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", err)
        if found:
            w, h, x, y = map(int, found[-1])
            boxes.append((x, y, x + w, y + h))
    W, H = info["width"], info["height"]
    if not boxes:
        return [0, 0, W, H]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    if (x1 - x0) * (y1 - y0) >= 0.97 * W * H:
        return [0, 0, W, H]
    return [x0, y0, (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2]


def grab_frame(path, t, crop, width=640):
    x, y, w, h = crop
    hh = int(round(width * h / w / 2)) * 2
    out = run(["-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-vf", f"crop={w}:{h}:{x}:{y},scale={width}:{hh}",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]).stdout
    if len(out) < width * hh * 3:
        return None
    return np.frombuffer(out[: width * hh * 3], np.uint8).reshape(hh, width, 3)


def face_box(path, info, crop, samples=12):
    """Median box of the largest face over the video, normalized to the content area."""
    import cv2
    det = None
    boxes = []
    for i in range(samples):
        t = info["duration"] * (0.08 + 0.84 * i / max(1, samples - 1))
        img = grab_frame(path, t, crop)
        if img is None:
            continue
        if det is None:
            det = cv2.FaceDetectorYN.create(str(YUNET), "", (img.shape[1], img.shape[0]), 0.6)
        _, faces = det.detect(img)
        if faces is None or not len(faces):
            continue
        f = max(faces, key=lambda r: r[2] * r[3])
        H, W = img.shape[:2]
        boxes.append([(f[0] + f[2] / 2) / W, (f[1] + f[3] / 2) / H, f[2] / W, f[3] / H])
    if not boxes:
        return None
    return [float(v) for v in np.median(np.array(boxes), axis=0)]  # cx, cy, w, h


def onset_envelope(path, secs=150, sr=8000, fs=200):
    raw = run(["-t", str(secs), "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    if x.size < sr:
        return None
    hop = sr // fs
    n = x.size // hop
    env = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    env = np.log(env + 1e-4)
    on = np.maximum(np.diff(env, prepend=env[0]), 0)  # sound starting: claps, syllables
    return (on - on.mean()) / (on.std() + 1e-9)


def audio_offset(screen, face, fs=200, max_lag=90):
    """Seconds d such that the same moment is at screen_time = face_time + d."""
    a, b = onset_envelope(screen, fs=fs), onset_envelope(face, fs=fs)
    if a is None or b is None:
        return 0.0, 0.0
    n = 1 << int(np.ceil(np.log2(a.size + b.size)))
    corr = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    lags = np.concatenate([np.arange(0, n // 2), np.arange(-n // 2, 0)])
    ok = np.abs(lags) <= max_lag * fs
    corr, lags = corr[ok], lags[ok]
    k = int(np.argmax(corr))
    peak = corr[k]
    away = np.abs(lags - lags[k]) > fs // 2
    second = corr[away].max() if away.any() else 0
    return float(lags[k] / fs), float(peak / (second + 1e-9))


def analyze(screen, face):
    si, fi = probe(screen), probe(face)
    crop = content_box(face, fi)
    box = face_box(face, fi, crop)
    d, conf = audio_offset(screen, face) if si["audio"] and fi["audio"] else (0.0, 0.0)
    return {"screen": si, "face": fi, "faceCrop": crop, "screenCrop": screen_content_box(screen, si), "faceBox": box, "offset": round(d, 3), "syncConfidence": round(conf, 2)}


# ---------------------------------------------------------------- layout
def even(v):
    return max(2, int(round(v / 2)) * 2)


def face_source_rect(a, aspect, zoom):
    """Crop (x, y, w, h) inside the face video for a destination of the given aspect, framed on the face."""
    cx0, cy0, cw, ch = a["faceCrop"]
    bw, bh = cw, cw / aspect
    if bh > ch:
        bh, bw = ch, ch * aspect
    z = max(1.0, zoom)
    sw, sh = bw / z, bh / z
    fb = a.get("faceBox")
    if fb:
        tx, ty = cx0 + fb[0] * cw, cy0 + fb[1] * ch + sh * 0.14  # face slightly above centre
    else:
        tx, ty = cx0 + cw / 2, cy0 + ch / 2
    x = min(max(tx - sw / 2, cx0), cx0 + cw - sw)
    y = min(max(ty - sh / 2, cy0), cy0 + ch - sh)
    return even(sw), even(sh), int(x), int(y)


def make_mask(w, h, shape, path):
    """Alpha mask (white = visible) for the face tile."""
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    if shape == "circle":
        d.ellipse((0, 0, w - 1, h - 1), fill=255)
    else:
        r = int(min(w, h) * (0.16 if shape in ("rounded", "tall") else 0.05))
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    m.save(path)


def make_frame(w, h, shape, path, border=True):
    """Drop shadow + white ring around the face tile, drawn on a canvas `pad` px larger on each side."""
    pad = int(min(w, h) * 0.12)
    W, H = w + 2 * pad, h + 2 * pad
    shadow = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(shadow)
    box = (pad, pad + int(pad * 0.2), pad + w - 1, pad + h - 1 + int(pad * 0.2))
    r = int(min(w, h) * (0.16 if shape in ("rounded", "tall") else 0.05))
    (d.ellipse(box, fill=150) if shape == "circle" else d.rounded_rectangle(box, radius=r, fill=150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(pad / 2.5))
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img.putalpha(shadow)
    if border:
        ring = ImageDraw.Draw(img)
        lw = max(3, int(min(w, h) * 0.018))
        b = (pad, pad, pad + w - 1, pad + h - 1)
        (ring.ellipse(b, outline=(255, 255, 255, 235), width=lw) if shape == "circle"
         else ring.rounded_rectangle(b, radius=r, outline=(255, 255, 255, 235), width=lw))
    img.save(path)
    return pad


def build(a, p, tmp: Path):
    """Return (extra_inputs, filter_complex, out_label) for the chosen layout.
    Inputs: 0 = screen, 1 = face, 2 = background colour, then extra image inputs."""
    vert = p["format"] == "vert"
    W, H = (1080, 1920) if vert else (1920, 1080)
    lay = p["layout"]
    zoom = float(p.get("zoom", 1.0))
    extra, f = [], []

    def screen_into(w, h, fit, label):
        z = max(1.0, float(p.get("screenZoom", 1)))
        px, py = float(p.get("panX", 0.5)), float(p.get("panY", 0.5))
        chain = "[0:v]"
        sc = a.get("screenCrop")
        if sc and p.get("trimBorders", True) and sc[2:] != [a["screen"]["width"], a["screen"]["height"]]:
            chain += f"crop={sc[2]}:{sc[3]}:{sc[0]}:{sc[1]},"
        chain += f"crop=iw/{z}:ih/{z}:(iw-iw/{z})*{px}:(ih-ih/{z})*{py},"
        if fit == "cover":
            chain += f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}:(iw-{w})*{px}:(ih-{h})*{py}"
        else:
            chain += f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={BG}"
        f.append(chain + f",setsar=1[{label}]")

    def face_into(w, h, label):
        sw, sh, sx, sy = face_source_rect(a, w / h, zoom)
        base = f"[1:v]crop={sw}:{sh}:{sx}:{sy}"
        if zoom >= 1:
            f.append(f"{base},scale={w}:{h}:flags=lanczos,setsar=1[{label}]")
        else:  # zoomed out: smaller picture over a blurred, stretched copy
            iw, ih = even(w * zoom), even(h * zoom)
            f.append(f"{base},split[{label}a][{label}b]")
            f.append(f"[{label}a]scale={w}:{h},boxblur=20:2,eq=brightness=-0.06[{label}bg]")
            f.append(f"[{label}b]scale={iw}:{ih}:flags=lanczos[{label}fg]")
            f.append(f"[{label}bg][{label}fg]overlay=(W-w)/2:(H-h)*0.5,setsar=1[{label}]")

    def tile(w, h, shape, x, y, base, label):
        """Masked face tile with shadow + ring overlaid on `base`."""
        face_into(w, h, label + "raw")
        mask = tmp / f"mask_{shape}_{w}x{h}.png"
        make_mask(w, h, shape, mask)
        frame = tmp / f"frame_{shape}_{w}x{h}.png"
        pad = make_frame(w, h, shape, frame, p.get("border", True))
        mi, fi = 3 + len(extra), 4 + len(extra)
        extra.extend([mask, frame])
        f.append(f"[{label}raw]format=rgba[{label}rgba];[{mi}:v]format=gray,scale={w}:{h}[{label}m];[{label}rgba][{label}m]alphamerge[{label}t]")
        f.append(f"[{base}][{fi}:v]overlay={x - pad}:{y - pad}[{label}s]")
        f.append(f"[{label}s][{label}t]overlay={x}:{y}:format=auto[{label}]")

    bg = f"[2:v]scale={W}:{H},setsar=1[bg]"
    if lay == "face":
        face_into(W, H, "out")
    elif lay == "screen":
        screen_into(W, H, p.get("fit", "cover" if vert else "contain"), "out")
    elif lay == "stack":
        sh = even(H * float(p.get("split", 0.5)))
        screen_into(W, sh, p.get("fit", "cover"), "scr")
        face_into(W, H - sh, "fc")
        f.append(bg)
        f.append(f"[bg][scr]overlay=0:0[b1];[b1][fc]overlay=0:{sh}[out]")
    elif lay == "side":
        # screen fills everything up to the face panel; face panel on the right
        pad, fw = even(H * 0.03), even(W * float(p.get("faceWidth", 0.26)))
        sw = even(W - fw - pad * 2)
        screen_into(sw, H, p.get("fit", "cover"), "scr")
        f.append(bg)
        f.append(f"[bg][scr]overlay=0:0[b1]")
        tile(fw, even(H - 2 * pad), "rounded", W - fw - pad, pad, "b1", "out")
    else:  # bubble
        screen_into(W, H, p.get("fit", "cover" if vert else "contain"), "scr")
        f.append(bg)
        f.append(f"[bg][scr]overlay=0:0[b1]")
        shape = p.get("shape", "circle")
        base = float(p.get("size", 0.3)) * min(W, H)
        bw, bh = base, base
        if shape == "rounded":
            bw, bh = (base, base * 1.25) if vert else (base * 1.33, base)
        if shape == "tall":
            bw, bh = base * 0.82, base * 1.2
        bw, bh = even(bw), even(bh)
        m = int(min(W, H) * 0.03)
        corner = p.get("corner", "br")
        x = m if corner[1] == "l" else W - bw - m
        y = m if corner[0] == "t" else H - bh - m
        tile(bw, bh, shape, x, y, "b1", "out")
    return extra, ";".join(f), "out", W, H


def timing(a, p):
    """Start offsets into each file and the usable duration, using the audio sync."""
    d = float(p.get("offset", a["offset"]))  # screen_time = face_time + d
    s0 = max(0.0, d)
    f0 = s0 - d
    dur = min(a["screen"]["duration"] - s0, a["face"]["duration"] - f0)
    return s0, f0, max(0.0, dur)


def command(a, p, out, tmp: Path, at=None):
    extra, graph, label, W, H = build(a, p, tmp)
    s0, f0, dur = timing(a, p)
    start = float(p.get("trimStart", 0))
    end = min(dur, float(p.get("trimEnd") or dur))
    lead = 0.0
    if at is not None:  # preview: start a little earlier so every input has delivered a frame
        lead = min(0.5, float(at) + s0, float(at) + f0)
        start, end = float(at) - lead, float(at) + 0.04
    args = ["-y", "-ss", f"{s0 + start:.3f}", "-i", p["screenPath"], "-ss", f"{f0 + start:.3f}", "-i", p["facePath"],
            "-f", "lavfi", "-i", f"color=c={BG}:s={W}x{H}:r=30"]
    for e in extra:
        args += ["-loop", "1", "-i", str(e)]
    args += ["-filter_complex", graph, "-map", f"[{label}]"]
    if at is not None:
        return args + ["-ss", f"{lead:.3f}", "-frames:v", "1", "-q:v", "3", str(out)]
    audio = "1:a" if p.get("audio", "face") == "face" else "0:a"
    return args + ["-map", audio, "-t", f"{end - start:.3f}", "-r", "30",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(out)]
