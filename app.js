import { Sink } from './sink.js';
import { Beauty } from './beauty.js';

const $= (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- settings
const LOOK = { autoLight: true, beauty: true, smooth: 0.5, spots: 0.6, even: 0.3, brighten: 0.25, sharpen: 0.3, warmth: 0.15, contrast: 1.05, saturation: 1.08 };
const BEAUTY_PRESETS = {
  natural: { beauty: true, smooth: 0.35, spots: 0.5, even: 0.2, brighten: 0.15, sharpen: 0.25 },
  soft: { beauty: true, smooth: 0.6, spots: 0.75, even: 0.4, brighten: 0.3, sharpen: 0.3 },
  glam: { beauty: true, smooth: 0.8, spots: 0.95, even: 0.55, brighten: 0.45, sharpen: 0.4 },
};
const DEFAULTS = {
  format: 'land', resLand: '1920x1080', resVert: '1080x1920', fps: 30, quality: 'high',
  sysAudio: true, cam: '', mic: '', camRes: '1920x1080',
  layoutLand: 'bubble', layoutVert: 'stack', fitLand: 'contain', fitVert: 'cover',
  sZoom: 1, sPanX: 0.5, sPanY: 0.5, split: 0.5,
  shape: 'circle', faceSize: 0.3, bubbleLand: { x: 0.86, y: 0.76 }, bubbleVert: { x: 0.72, y: 0.8 },
  autoFrame: true, faceZoom: 1.0, showSkin: false, mirror: true, border: true,
  bg: 'blur', blurAmt: 12, bgColor: '#1b2233',
  ...LOOK,
  voiceEnhance: true, noiseSup: true, echoCancel: false, micGain: 1, sysGain: 0.8, countdown: true,
};
const STORE_KEY = 'studioRecorder.settings.v1';
const S = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* private mode */ }
  return { ...DEFAULTS, ...saved };
})();
const saveSettings = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* ignore */ } };

const LAYOUTS = {
  land: [['bubble', 'Screen + Face'], ['side', 'Side by side'], ['face', 'Face only'], ['screen', 'Screen only']],
  vert: [['stack', 'Stacked'], ['bubble', 'Screen + Face'], ['face', 'Face only'], ['screen', 'Screen only']],
};
const RES = {
  land: [['1280x720', '720p'], ['1920x1080', '1080p Full HD'], ['2560x1440', '1440p QHD'], ['3840x2160', '4K UHD']],
  vert: [['720x1280', '720 × 1280'], ['1080x1920', '1080 × 1920 (Reels/Shorts)'], ['1440x2560', '1440 × 2560']],
};
const isVert = () => S.format === 'vert';
const layout = () => (isVert() ? S.layoutVert : S.layoutLand);
const screenFit = () => (isVert() ? S.fitVert : S.fitLand);
const bubblePos = () => (isVert() ? S.bubbleVert : S.bubbleLand);
const outSize = () => (isVert() ? S.resVert : S.resLand).split('x').map(Number);

// ---------------------------------------------------------------- frame sources
// MediaStreamTrackProcessor delivers frames even when the window is hidden;
// fall back to a <video> element where it is unavailable.
class FrameSource {
  constructor(track) {
    this.track = track;
    this.frame = null;
    this.video = null;
    this.alive = true;
    if ('MediaStreamTrackProcessor' in window) {
      this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      this.pump();
    } else {
      this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
      this.video.srcObject = new MediaStream([track]);
      $('hiddenHost').appendChild(this.video);
      this.video.play().catch(() => {});
    }
  }
  async pump() {
    try {
      while (this.alive) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.frame?.close();
        this.frame = value;
      }
    } catch { /* track ended */ }
  }
  get image() { return this.frame || (this.video && this.video.readyState >= 2 ? this.video : null); }
  get width() { return this.frame ? this.frame.displayWidth : this.video?.videoWidth || 0; }
  get height() { return this.frame ? this.frame.displayHeight : this.video?.videoHeight || 0; }
  stop() {
    this.alive = false;
    this.reader?.cancel().catch(() => {});
    this.frame?.close();
    this.frame = null;
    this.video?.remove();
    this.track.stop();
  }
}

const layer = (opts) => { const canvas = document.createElement('canvas'); return { canvas, ctx: canvas.getContext('2d', opts) }; };
const sized = (l, w, h) => { if (l.canvas.width !== w || l.canvas.height !== h) { l.canvas.width = w; l.canvas.height = h; } return l.ctx; };
const L = { face: layer(), person: layer(), bg: layer(), pad: layer(), fmask: layer(), light: layer({ willReadFrequently: true }) };
const FACE_MAX = 1920; // face layer is rendered at most this size, then scaled

const scr = { src: null, label: '' };
const cam = { src: null };
function resetCamState() {
  Object.assign(cam, { face: null, marks: null, crop: null, cropT: 0, light: 1, lastLight: 0, maskReady: false, maskW: 0, maskH: 0, maskCanvas: null });
  vision.worker?.postMessage({ cmd: 'reset' });
}

// ---------------------------------------------------------------- face AI (MediaPipe, in a worker)
const vision = { worker: null, ready: false, busy: false, delegate: '' };
resetCamState();

function initVision() {
  if (vision.worker) return;
  setPill('pillAI', '', 'Face AI: loading…');
  vision.worker = new Worker('vision-worker.js', { type: 'module' });
  vision.worker.onmessage = ({ data }) => {
    if (data.ready) { vision.ready = true; vision.delegate = data.ready; setPill('pillAI', 'ok', `Face AI: on (${data.ready})`); return; }
    if (data.error) { setPill('pillAI', 'warn', 'Face AI unavailable'); toast('Face AI failed to load: ' + data.error); return; }
    vision.busy = false;
    if (data.face !== undefined) cam.face = data.face;
    if (data.marks !== undefined) cam.marks = data.marks;
    if (data.mask) applyMask(data.mask);
  };
  vision.worker.onerror = (e) => { setPill('pillAI', 'warn', 'Face AI unavailable'); console.warn('vision worker', e); };
}

function applyMask({ data, w, h }) {
  if (cam.maskW !== w || cam.maskH !== h) {
    cam.maskCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    cam.maskW = w; cam.maskH = h;
  }
  cam.maskCanvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  cam.maskReady = true;
}

function analyze(now) {
  const src = cam.src;
  if (!src || !src.image || !src.width || layout() === 'screen') return;
  const needSeg = S.bg !== 'none' || (S.shape === 'cutout' && layout() === 'bubble');
  const needFace = S.autoFrame || S.autoLight || S.beauty;
  if (!needSeg && !needFace) return;
  if (!vision.worker) initVision();
  const aw = 480, ah = Math.round((aw * src.height) / src.width);

  if (vision.ready && !vision.busy) {
    // One frame in flight at a time: the AI runs as fast as the GPU allows without ever blocking the UI.
    vision.busy = true;
    createImageBitmap(src.image, { resizeWidth: aw, resizeHeight: ah, resizeQuality: 'medium' })
      .then((bitmap) => vision.worker.postMessage({ bitmap, doSeg: needSeg, doFace: needFace }, [bitmap]))
      .catch(() => (vision.busy = false));
  }

  if (S.autoLight && now - cam.lastLight >= 400) {
    cam.lastLight = now;
    const f = cam.face || { cx: 0.5, cy: 0.45, w: 0.3, h: 0.4 };
    const lc = sized(L.light, 16, 16);
    lc.drawImage(src.image, (f.cx - f.w * 0.35) * src.width, (f.cy - f.h * 0.35) * src.height, f.w * 0.7 * src.width, f.h * 0.7 * src.height, 0, 0, 16, 16);
    const px = lc.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const luma = Math.max(8, sum / 256);
    cam.light = lerp(cam.light, clamp(132 / luma, 0.9, 1.7), 0.25);
  }
}

// ---------------------------------------------------------------- compositing
function computeCrop(A, vw, vh) {
  let bw = vw, bh = vw / A;
  if (bh > vh) { bh = vh; bw = vh * A; }
  // zoom < 1 zooms out past the camera frame (more of you visible; renderFace pads the edges)
  let z = S.faceZoom, tx = vw / 2, ty = vh / 2;
  const f = S.autoFrame && cam.face;
  if (f) {
    z = Math.min(z, Math.max(1, (bh * 0.6) / (f.h * vh))); // when zooming in, keep the whole face in frame
    tx = f.cx * vw;
    ty = f.cy * vh + (bh / z) * 0.14; // face a little above centre; zoomed out, more body shows below
  }
  const now = performance.now();
  const dt = cam.cropT ? Math.min(200, now - cam.cropT) : 16.7;
  cam.cropT = now;
  const k = 1 - Math.pow(0.93, dt / 16.7);
  if (!cam.crop) cam.crop = { x: tx, y: ty, z };
  cam.crop.x = lerp(cam.crop.x, tx, k);
  cam.crop.y = lerp(cam.crop.y, ty, k);
  cam.crop.z = lerp(cam.crop.z, z, k);
  const sw = bw / cam.crop.z, sh = bh / cam.crop.z;
  const cx = sw >= vw ? vw / 2 : clamp(cam.crop.x, sw / 2, vw - sw / 2);
  const cy = sh >= vh ? vh / 2 : clamp(cam.crop.y, sh / 2, vh - sh / 2);
  return [cx - sw / 2, cy - sh / 2, sw, sh];
}

// Beautified camera frame (GPU), computed once per rendered frame.
let beauty;
try { beauty = new Beauty(); } catch (e) { console.warn('beauty filter unavailable', e); beauty = { ok: false }; }
let beautyCache = { key: -1, out: null }, compareHeld = false;
function beautify(src, raw) {
  if (!S.beauty || compareHeld || !beauty.ok || !cam.marks || !cam.face) return raw;
  if (beautyCache.key === perf.frames) return beautyCache.out;
  try {
    const out = beauty.process(raw, src.width, src.height, cam.marks, cam.face.w * src.width,
      { smooth: S.smooth, spots: S.spots, even: S.even, brighten: S.brighten, sharpen: S.sharpen, showMask: S.showSkin });
    beautyCache = { key: perf.frames, out };
    return out;
  } catch (e) {
    console.warn('beauty filter failed', e);
    beauty.ok = false;
    return raw;
  }
}

function tint(c, w, h) {
  if (S.warmth <= 0.01) return;
  c.save();
  c.globalCompositeOperation = 'soft-light';
  c.fillStyle = `rgba(255,140,60,${(S.warmth * 0.4).toFixed(3)})`;
  c.fillRect(0, 0, w, h);
  c.restore();
}

// Zoomed out past the camera's edges: the picture sits inside the frame with soft edges, over a
// blurred, stretched copy of the scene (or the background colour) that fills the margins.
function padMargins(c, img, src, w, h, sx, sy, sw, sh) {
  const rx = (Math.max(0, -sx) / sw) * w, ry = (Math.max(0, -sy) / sh) * h;
  const rw = (Math.min(src.width, sx + sw) - Math.max(0, sx)) / sw * w;
  const rh = (Math.min(src.height, sy + sh) - Math.max(0, sy)) / sh * h;
  const f = Math.max(4, Math.min(w, h) * 0.04);
  const fm = sized(L.fmask, w, h);
  fm.clearRect(0, 0, w, h);
  fm.filter = `blur(${(f / 2).toFixed(1)}px)`;
  fm.fillStyle = '#fff';
  // feather only the edges that border a margin
  const x0 = sx < 0 ? rx + f : -2 * f, y0 = sy < 0 ? ry + f : -2 * f;
  const x1 = sx + sw > src.width ? rx + rw - f : w + 2 * f, y1 = sy + sh > src.height ? ry + rh - f : h + 2 * f;
  fm.fillRect(x0, y0, x1 - x0, y1 - y0);
  fm.filter = 'none';
  c.save();
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(L.fmask.canvas, 0, 0);
  c.globalCompositeOperation = 'destination-over';
  if (S.bg === 'color') {
    c.fillStyle = S.bgColor;
    c.fillRect(0, 0, w, h);
  } else {
    const bw = Math.max(16, Math.round(w / 8)), bh = Math.max(16, Math.round(h / 8));
    const p = sized(L.pad, bw, bh);
    const k = Math.max(bw / src.width, bh / src.height) * 1.1, dw = src.width * k, dh = src.height * k;
    p.drawImage(img, (bw - dw) / 2, (bh - dh) / 2, dw, dh);            // sharp underlay: no transparent edges
    p.filter = 'blur(3px)';
    p.drawImage(img, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
    p.filter = 'none';
    c.filter = 'brightness(0.8)';
    c.drawImage(L.pad.canvas, 0, 0, w, h);
    c.filter = 'none';
  }
  c.restore();
}

function renderFace(dw, dh, cutout) {
  const src = cam.src, raw = src?.image;
  if (!raw || !src.width) return null;
  const img = beautify(src, raw);
  const [sx, sy, sw, sh] = computeCrop(dw / dh, src.width, src.height);
  // Work at no more pixels than the camera crop really has; the result is upscaled once when drawn.
  const s = Math.min(1, FACE_MAX / Math.max(dw, dh), sw / dw);
  const w = Math.max(2, Math.round(dw * s)), h = Math.max(2, Math.round(dh * s));
  const F = `brightness(${(S.autoLight ? cam.light : 1).toFixed(3)}) contrast(${S.contrast}) saturate(${S.saturation})`;
  const c = sized(L.face, w, h);
  c.clearRect(0, 0, w, h);
  const seg = cam.maskReady && (cutout || S.bg !== 'none');
  if (!seg) {
    c.filter = F;
    c.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    c.filter = 'none';
    tint(c, w, h);
  } else {
    if (!cutout && S.bg === 'blur') {
      // Blur at quarter resolution, then upscale: looks the same, costs ~1/16th.
      const bw = Math.max(16, Math.round(w / 4)), bh = Math.max(16, Math.round(h / 4));
      const px = Math.max(1, (S.blurAmt * bw) / 640);
      const b = sized(L.bg, bw, bh);
      b.filter = `${F} blur(${px.toFixed(1)}px)`;
      b.drawImage(img, sx, sy, sw, sh, -px * 2, -px * 2, bw + px * 4, bh + px * 4);
      b.filter = 'none';
      c.drawImage(L.bg.canvas, 0, 0, w, h);
      tint(c, w, h);
      c.fillStyle = 'rgba(0,0,0,0.12)'; // slightly darker background makes you pop
      c.fillRect(0, 0, w, h);
    } else if (!cutout) {
      c.fillStyle = S.bgColor;
      c.fillRect(0, 0, w, h);
    }
    const p = sized(L.person, w, h);
    p.clearRect(0, 0, w, h);
    p.filter = F;
    p.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    p.filter = 'none';
    tint(p, w, h);
    p.globalCompositeOperation = 'destination-in';
    p.filter = `blur(${Math.max(1, w / 360).toFixed(1)}px)`; // feathered edge
    const kx = cam.maskW / src.width, ky = cam.maskH / src.height;
    p.drawImage(cam.maskCanvas, sx * kx, sy * ky, sw * kx, sh * ky, 0, 0, w, h);
    p.filter = 'none';
    p.globalCompositeOperation = 'source-over';
    c.drawImage(L.person.canvas, 0, 0);
  }
  if (!cutout && (sx < 0 || sy < 0 || sx + sw > src.width || sy + sh > src.height)) padMargins(c, img, src, w, h, sx, sy, sw, sh);
  return { canvas: L.face.canvas, w, h };
}

function shapePath(c, x, y, w, h, shape) {
  c.beginPath();
  if (shape === 'circle') c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else c.roundRect(x, y, w, h, shape === 'rounded' ? Math.min(w, h) * 0.16 : shape === 'square' ? Math.min(w, h) * 0.06 : 0);
}

function placeholder(c, x, y, w, h, text) {
  c.fillStyle = '#151922';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#5d6678';
  c.font = `500 ${Math.round(Math.min(w, h) * 0.05)}px "Segoe UI", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x + w / 2, y + h / 2);
}

function drawFace(c, x, y, w, h, shape) {
  let cutout = false;
  if (shape === 'cutout') { if (cam.maskReady) cutout = true; else shape = 'rounded'; }
  const lay = renderFace(w, h, cutout);
  if (!lay) { if (shape === 'rect') placeholder(c, x, y, w, h, 'Camera off'); return; }
  const framed = !cutout && shape !== 'rect';
  if (framed) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = Math.min(w, h) * 0.08;
    c.shadowOffsetY = Math.min(w, h) * 0.02;
    shapePath(c, x, y, w, h, shape);
    c.fillStyle = '#000';
    c.fill();
    c.restore();
  }
  c.save();
  if (!cutout) { shapePath(c, x, y, w, h, framed ? shape : 'rect'); c.clip(); }
  if (S.mirror) { c.translate(x + w, y); c.scale(-1, 1); c.drawImage(lay.canvas, 0, 0, lay.w, lay.h, 0, 0, w, h); }
  else c.drawImage(lay.canvas, 0, 0, lay.w, lay.h, x, y, w, h);
  c.restore();
  if (framed && S.border) {
    shapePath(c, x, y, w, h, shape);
    c.lineWidth = Math.max(3, Math.min(w, h) * 0.018);
    c.strokeStyle = 'rgba(255,255,255,0.92)';
    c.stroke();
  }
}

function drawScreen(c, x, y, w, h, fit) {
  const img = scr.src?.image;
  if (!img || !scr.src.width) { placeholder(c, x, y, w, h, 'Click “Choose screen / window” to share your screen'); return; }
  const vw = scr.src.width, vh = scr.src.height;
  let cw = vw / S.sZoom, ch = vh / S.sZoom;
  if (fit === 'cover') { const A = w / h; if (cw / ch > A) cw = ch * A; else ch = cw / A; }
  const sx = (vw - cw) * S.sPanX, sy = (vh - ch) * S.sPanY;
  let dx = x, dy = y, dw = w, dh = h;
  if (fit === 'contain') { const k = Math.min(w / cw, h / ch); dw = cw * k; dh = ch * k; dx = x + (w - dw) / 2; dy = y + (h - dh) / 2; }
  c.drawImage(img, sx, sy, cw, ch, dx, dy, dw, dh);
}

function bubbleRect(W, H) {
  const base = S.faceSize * Math.min(W, H);
  let w = base, h = base;
  if (S.shape === 'rounded') { if (isVert()) h = base * 1.25; else w = base * 1.33; }
  if (S.shape === 'tall') { w = base * 0.82; h = base * 1.2; }
  if (S.shape === 'cutout') h = base * 1.3;
  const m = Math.min(W, H) * 0.025, pos = bubblePos();
  const cx = clamp(pos.x * W, w / 2 + m, W - w / 2 - m), cy = clamp(pos.y * H, h / 2 + m, H - h / 2 - m);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const out = $('out');
const octx = out.getContext('2d', { alpha: false });
const hit = { bubble: null, screen: null };
let bgGrad = null, lastRender = 0;

function render() {
  const now = performance.now();
  if (now - lastRender < (1000 / S.fps) * 0.3) return; // drop only bursts of late, queued ticks
  lastRender = now;
  analyze(now);
  const tAna = performance.now();
  const [W, H] = outSize();
  if (out.width !== W || out.height !== H) { out.width = W; out.height = H; bgGrad = null; }
  const c = octx;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  if (!bgGrad) {
    bgGrad = c.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#161b26');
    bgGrad.addColorStop(1, '#090b0f');
  }
  c.fillStyle = bgGrad;
  c.fillRect(0, 0, W, H);
  hit.bubble = hit.screen = null;
  // No camera (e.g. Zoom is using it): record the screen full-frame instead of leaving an empty face panel.
  const lay = !cam.src && layout() !== 'face' ? 'screen' : layout(), fit = screenFit();
  if (lay === 'bubble') {
    drawScreen(c, 0, 0, W, H, fit);
    hit.screen = { x: 0, y: 0, w: W, h: H };
    if (cam.src) { hit.bubble = bubbleRect(W, H); drawFace(c, hit.bubble.x, hit.bubble.y, hit.bubble.w, hit.bubble.h, S.shape); }
  } else if (lay === 'side') {
    const pad = Math.round(H * 0.035), fw = Math.round(W * 0.28);
    hit.screen = { x: pad, y: pad, w: W - fw - pad * 3, h: H - pad * 2 };
    drawScreen(c, hit.screen.x, hit.screen.y, hit.screen.w, hit.screen.h, fit);
    drawFace(c, W - fw - pad, pad, fw, H - pad * 2, 'rounded');
  } else if (lay === 'stack') {
    const sh = Math.round(H * S.split);
    hit.screen = { x: 0, y: 0, w: W, h: sh };
    drawScreen(c, 0, 0, W, sh, fit);
    drawFace(c, 0, sh, W, H - sh, 'rect');
  } else if (lay === 'face') {
    drawFace(c, 0, 0, W, H, 'rect');
  } else {
    hit.screen = { x: 0, y: 0, w: W, h: H };
    drawScreen(c, 0, 0, W, H, fit);
  }
  if (rec.enc) encodeFrame();
  else rec.track?.requestFrame();
  const end = performance.now();
  perf.ana = lerp(perf.ana, tAna - now, 0.1);
  perf.draw = lerp(perf.draw, end - tAna, 0.1);
  perf.frames++;
}
const perf = { ana: 0, draw: 0, frames: 0, skipped: 0, dropped: 0 };
// ?engine=mediarecorder forces the fallback recorder (for testing)
const FORCE_MR = new URLSearchParams(location.search).get('engine') === 'mediarecorder';

const ticker = new Worker('tick-worker.js');
ticker.onmessage = render;
const startTicks = () => ticker.postMessage({ cmd: 'start', fps: S.fps });

// ---------------------------------------------------------------- audio
const audio = { ctx: null, dest: null, analyser: null, micStream: null, micSrc: null, micNodes: [], micGain: null, sysSrc: null, sysGain: null };

function ensureAudio() {
  if (!audio.ctx) {
    audio.ctx = new AudioContext({ sampleRate: 48000 });
    audio.dest = audio.ctx.createMediaStreamDestination();
    audio.dest.channelCount = 2;
    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 1024;
    audio.sysGain = audio.ctx.createGain();
    audio.sysGain.gain.value = S.sysGain;
    audio.sysGain.connect(audio.dest);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
}

function buildMicChain() {
  if (!audio.micSrc) return;
  const a = audio.ctx;
  audio.micSrc.disconnect();
  audio.micNodes.forEach((n) => n.disconnect());
  const nodes = [];
  const biquad = (type, f, q, g) => {
    const n = a.createBiquadFilter();
    n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = g;
    return n;
  };
  const comp = (t, knee, ratio, att, rel) => {
    const n = a.createDynamicsCompressor();
    n.threshold.value = t; n.knee.value = knee; n.ratio.value = ratio; n.attack.value = att; n.release.value = rel;
    return n;
  };
  if (S.voiceEnhance) {
    const makeup = a.createGain();
    makeup.gain.value = 1.6;
    nodes.push(
      biquad('highpass', 85, 0.7, 0),     // rumble / desk thumps
      biquad('peaking', 300, 1.0, -2),    // boxiness
      biquad('peaking', 3500, 0.9, 3),    // presence / clarity
      biquad('highshelf', 10000, 0.7, 2), // air
      comp(-24, 8, 3.5, 0.004, 0.2),      // leveler
      makeup,
      comp(-2, 0, 20, 0.001, 0.05),       // limiter
    );
  }
  audio.micGain = a.createGain();
  audio.micGain.gain.value = S.micGain;
  nodes.push(audio.micGain);
  let prev = audio.micSrc;
  for (const n of nodes) { prev.connect(n); prev = n; }
  prev.connect(audio.dest);
  prev.connect(audio.analyser);
  audio.micNodes = nodes;
}

async function startMic(id) {
  ensureAudio();
  audio.micSrc?.disconnect();
  audio.micStream?.getTracks().forEach((t) => t.stop());
  audio.micSrc = audio.micStream = null;
  if (id === 'off') { setPill('pillMic', '', 'Mic off'); return; }
  const a = { channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, echoCancellation: S.echoCancel, noiseSuppression: S.noiseSup, autoGainControl: false };
  if (id) a.deviceId = { exact: id };
  try {
    audio.micStream = await navigator.mediaDevices.getUserMedia({ audio: a });
    audio.micSrc = audio.ctx.createMediaStreamSource(audio.micStream);
    buildMicChain();
    setPill('pillMic', 'ok', 'Mic: ' + shortLabel(audio.micStream.getAudioTracks()[0].label));
  } catch (e) {
    if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return startMic('');
    setPill('pillMic', 'warn', 'Mic blocked');
    toast('Microphone: ' + e.message);
  }
}

function connectSystemAudio(track) {
  audio.sysSrc?.disconnect();
  audio.sysSrc = track ? audio.ctx.createMediaStreamSource(new MediaStream([track])) : null;
  audio.sysSrc?.connect(audio.sysGain);
}

const meterBuf = new Float32Array(1024);
function meterTick() {
  if (!audio.analyser || !audio.micSrc) { $('meterBar').style.width = '0'; return; }
  audio.analyser.getFloatTimeDomainData(meterBuf);
  let sum = 0;
  for (const v of meterBuf) sum += v * v;
  const db = 20 * Math.log10(Math.sqrt(sum / meterBuf.length) + 1e-6);
  $('meterBar').style.width = clamp((db + 60) / 60, 0, 1) * 100 + '%';
}

// ---------------------------------------------------------------- camera / screen
const shortLabel = (s) => (s || 'default').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, '').slice(0, 28);

async function startCamera(id) {
  cam.src?.stop();
  cam.src = null;
  resetCamState();
  if (id === 'off') { setPill('pillCam', '', 'Camera off'); return; }
  const [w, h] = S.camRes.split('x').map(Number);
  const v = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: Math.max(30, S.fps) } };
  if (id) v.deviceId = { exact: id };
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: v });
    const t = st.getVideoTracks()[0];
    cam.src = new FrameSource(t);
    const s = t.getSettings();
    setPill('pillCam', 'ok', `Camera ${s.width}×${s.height}`);
    t.addEventListener('ended', () => setPill('pillCam', 'warn', 'Camera disconnected'));
  } catch (e) {
    if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return startCamera('');
    setPill('pillCam', 'warn', 'Camera blocked');
    toast('Camera: ' + e.message);
  }
}

// Capture the screen no larger than the output needs: on high-DPI (e.g. 4K) laptops Windows then
// downscales on the GPU, instead of pushing full-resolution frames through the page every frame.
function screenCaptureSize() {
  const long = Math.max(...outSize());
  const w = long > 2560 ? 3840 : long > 1920 ? 2560 : 1920;
  return { width: { max: w }, height: { max: Math.round((w * 9) / 16) } };
}
const fitScreenCapture = () => scr.src?.track.applyConstraints({ frameRate: { ideal: S.fps, max: 60 }, ...screenCaptureSize() }).catch(() => {});

async function startScreen() {
  ensureAudio();
  let st;
  try {
    st = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: S.fps, max: 60 }, ...screenCaptureSize(), cursor: 'always' },
      audio: S.sysAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 2 } : false,
      systemAudio: S.sysAudio ? 'include' : 'exclude',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Screen share failed: ' + e.message);
    return;
  }
  scr.src?.stop();
  const vt = st.getVideoTracks()[0];
  vt.contentHint = 'detail';
  scr.src = new FrameSource(vt);
  const surface = vt.getSettings().displaySurface;
  scr.label = surface === 'monitor' ? 'Entire screen' : surface === 'window' ? 'Window' : 'Tab';
  const at = st.getAudioTracks()[0];
  connectSystemAudio(at || null);
  setPill('pillScreen', 'ok', `Screen: ${scr.label}${at ? ' + sound' : ''}`);
  $('btnScreen').textContent = 'Change screen / window';
  if (S.sysAudio && !at && surface === 'monitor') toast('Tip: tick “Also share system audio” in the share dialog to record PC sound.');
  vt.addEventListener('ended', () => {
    if (scr.src?.track !== vt) return;
    scr.src.stop();
    scr.src = null;
    connectSystemAudio(null);
    setPill('pillScreen', '', 'Screen: not shared');
    $('btnScreen').textContent = 'Choose screen / window';
    if (rec.state === 'recording' || rec.state === 'paused') { toast('Screen sharing ended — recording saved.'); stopRecording(); }
  });
}

async function refreshDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current, activeLabel) => {
    const list = devs.filter((d) => d.kind === kind && d.deviceId !== 'communications');
    sel.innerHTML = '';
    sel.append(new Option('Off', 'off'));
    list.forEach((d, i) => sel.append(new Option(d.label || `${kind === 'videoinput' ? 'Camera' : 'Mic'} ${i + 1}`, d.deviceId)));
    const match = list.find((d) => d.deviceId === current) || list.find((d) => activeLabel && d.label === activeLabel);
    sel.value = current === 'off' ? 'off' : match ? match.deviceId : list[0]?.deviceId || 'off';
  };
  fill($('camSel'), 'videoinput', S.cam, cam.src?.track.label);
  fill($('micSel'), 'audioinput', S.mic, audio.micStream?.getAudioTracks()[0]?.label);
}

// ---------------------------------------------------------------- recording
// Primary engine: WebCodecs in encoder-worker.js (hardware H.264 when available + Opus, muxed to
// MP4 and streamed to disk). Fallback: MediaRecorder on a canvas capture stream.
const rec = { state: 'idle', id: null, sink: null, enc: null, venc: null, mr: null, track: null, mime: '', elapsed: 0, segStart: 0, lastFile: '' };
const absTime = (t) => performance.timeOrigin + t;

function pickMime() {
  return [
    'video/mp4;codecs=avc1.640033,mp4a.40.2',
    'video/mp4;codecs=avc1.640033,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function videoBitrate() {
  const [W, H] = outSize();
  const bpp = S.quality === 'ultra' ? 0.36 : 0.2; // bits per pixel per frame @30fps
  return Math.round(Math.min(120e6, W * H * 30 * bpp * Math.pow(S.fps / 30, 0.75)));
}

async function webCodecsConfig(W, H) {
  if (FORCE_MR || !('VideoEncoder' in window) || !('MediaStreamTrackProcessor' in window)) return null;
  const base = { codec: 'avc1.640033', width: W, height: H, bitrate: videoBitrate(), bitrateMode: 'variable', framerate: S.fps, avc: { format: 'avc' }, latencyMode: 'realtime' };
  const order = new URLSearchParams(location.search).get('encoder') === 'software' ? ['prefer-software'] : ['prefer-hardware', 'no-preference'];
  for (const hardwareAcceleration of order) {
    const cfg = { ...base, hardwareAcceleration };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
  }
  return null;
}

function startEncoderWorker(vcfg) {
  return new Promise((resolve, reject) => {
    const w = new Worker('encoder-worker.js', { type: 'module' });
    rec.enc = w;
    w.onmessage = ({ data }) => {
      if (data.started) resolve();
      else if (data.done) rec.encDone?.(data);
      else if (data.error) {
        console.error('encoder:', data.error);
        if (rec.state === 'countdown') reject(new Error(data.error));
        else { toast('Encoder error: ' + data.error); stopRecording(); }
      }
    };
    w.onerror = (e) => reject(new Error(e.message || 'encoder worker failed'));
    // Video is encoded here (GPU canvas frames are cheapest to encode on the thread that draws them);
    // only the small compressed chunks go to the worker, which also owns audio and muxing.
    rec.venc = new VideoEncoder({
      output: (chunk, meta) => w.postMessage({ cmd: 'video', chunk, meta }),
      error: (e) => { toast('Video encoder error: ' + e.message); stopRecording(); },
    });
    rec.venc.configure(vcfg);
    rec.lastTs = -1;
    rec.lastKey = -Infinity;
    const track = audio.dest.stream.getAudioTracks()[0]?.clone();
    const readable = track ? new MediaStreamTrackProcessor({ track }).readable : null;
    rec.encTrack = track;
    w.postMessage({ cmd: 'start', id: rec.id, width: vcfg.width, height: vcfg.height, fps: vcfg.framerate,
      sampleRate: audio.ctx.sampleRate, audio: readable, startAbs: absTime(rec.segStart) }, readable ? [readable] : []);
  });
}

function encodeFrame() {
  if (rec.state !== 'recording' || rec.venc?.state !== 'configured') return;
  if (rec.venc.encodeQueueSize > 12) { perf.skipped++; return; } // encoder behind: skip rather than lag
  const ts = Math.round((rec.elapsed + performance.now() - rec.segStart) * 1000);
  if (ts <= rec.lastTs) return;
  rec.lastTs = ts;
  const keyFrame = ts - rec.lastKey >= 2e6; // keyframe every 2 s
  if (keyFrame) rec.lastKey = ts;
  const frame = new VideoFrame(out, { timestamp: ts });
  rec.venc.encode(frame, { keyFrame });
  frame.close();
}

async function stopEncoderWorker() {
  rec.enc.postMessage({ cmd: 'pause', at: absTime(performance.now()) }); // freeze audio at the stop moment
  try { await rec.venc.flush(); } catch (e) { console.warn(e); }
  rec.venc.close();
  rec.venc = null;
  return new Promise((resolve) => {
    rec.encDone = resolve;
    rec.enc.postMessage({ cmd: 'stop' });
  });
}

function startMediaRecorder() {
  const stream = out.captureStream(0);
  rec.track = stream.getVideoTracks()[0];
  rec.track.contentHint = layout() === 'face' ? 'motion' : 'detail';
  audio.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  rec.mr = new MediaRecorder(stream, { mimeType: rec.mime, videoBitsPerSecond: videoBitrate(), audioBitsPerSecond: 320000 });
  rec.mr.ondataavailable = (e) => e.data.size && rec.sink.append(e.data);
  rec.mr.onstop = () => finishRecording();
  rec.mr.start(1000);
}

async function startRecording() {
  if (rec.state !== 'idle') return;
  ensureAudio();
  if (!scr.src && layout() !== 'face') toast('No screen shared yet — use “Choose screen / window” first.');
  rec.state = 'countdown';
  updateUI();
  if (S.countdown) {
    const el = $('countdown');
    el.hidden = false;
    for (const n of [3, 2, 1]) { el.textContent = n; if (mini) mini.timer.textContent = `in ${n}…`; await sleep(1000); }
    el.hidden = true;
  }
  const [W, H] = outSize();
  const vcfg = await webCodecsConfig(W, H);
  rec.mime = vcfg ? 'video/mp4;codecs=avc1,opus' : pickMime();
  rec.id = null;
  try {
    const ext = rec.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const r = await fetch(`/api/start?ext=${ext}&mode=${S.format}&mime=${encodeURIComponent(rec.mime)}`, { method: 'POST' });
    rec.id = (await r.json()).id || null;
  } catch { /* no server: keep in memory and download at the end */ }
  rec.elapsed = 0;
  rec.segStart = performance.now();
  try {
    if (vcfg) await startEncoderWorker(vcfg);
    else { rec.sink = new Sink(rec.id); startMediaRecorder(); }
  } catch (e) {
    toast('Could not start recording: ' + e.message);
    rec.enc?.terminate();
    rec.enc = null;
    rec.state = 'idle';
    updateUI();
    return;
  }
  rec.state = 'recording';
  setStatus(`Recording ${W}×${H} @ ${S.fps} fps${vcfg?.hardwareAcceleration === 'prefer-hardware' ? ' · HW encoder' : ''}`, '');
  updateUI();
}

function togglePause() {
  const now = performance.now();
  if (rec.state === 'recording') {
    rec.mr?.pause();
    rec.enc?.postMessage({ cmd: 'pause', at: absTime(now) });
    rec.elapsed += now - rec.segStart;
    rec.state = 'paused';
  } else if (rec.state === 'paused') {
    rec.mr?.resume();
    rec.enc?.postMessage({ cmd: 'resume', at: absTime(now) });
    rec.segStart = now;
    rec.state = 'recording';
  }
  updateUI();
}

async function stopRecording() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  if (rec.state === 'recording') rec.elapsed += performance.now() - rec.segStart;
  rec.state = 'saving';
  updateUI();
  if (rec.enc) {
    setStatus('Saving…', '');
    const res = await stopEncoderWorker();
    rec.enc.terminate();
    rec.enc = null;
    rec.encTrack?.stop();
    finishRecording(res);
  } else rec.mr.stop(); // onstop -> finishRecording
}

async function finishRecording(res = {}) {
  rec.track?.stop();
  rec.track = rec.mr = null;
  setStatus('Saving…', '');
  let blob = res.blob;
  let failed = res.failed;
  if (rec.sink) {
    rec.sink.flush();
    await rec.sink.queue;
    failed = rec.sink.failed;
    if (rec.sink.mem) blob = await rec.sink.toBlob(rec.mime.split(';')[0]);
    rec.sink = null;
  }
  try {
    if (!rec.id) downloadLocal(blob);
    else {
      if (failed) toast('Some data could not be written to disk — the file may be incomplete.');
      await fetch(`/api/finish?id=${rec.id}`, { method: 'POST' });
      setStatus('Finalizing MP4…', '');
      for (;;) {
        await sleep(600);
        const s = await (await fetch(`/api/status?id=${rec.id}`)).json();
        if (s.state === 'done') {
          rec.lastFile = s.file;
          setStatus(`${s.warning ? '⚠ ' : '✓ Saved '}${s.file.split(/[\\/]/).pop()}`, s.warning ? 'warn' : 'ok', s.file);
          if (s.warning) toast(s.warning);
          break;
        }
        if (s.state === 'error') { setStatus('Save failed', 'warn'); toast(s.error); break; }
      }
    }
  } catch (e) {
    setStatus('Save failed', 'warn');
    toast('Saving failed: ' + e.message);
  }
  rec.state = 'idle';
  updateUI();
}

function downloadLocal(blob) {
  if (!blob?.size) { setStatus('Nothing recorded', 'warn'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}_${isVert() ? 'Reel' : 'Video'}.${blob.type === 'video/webm' ? 'webm' : 'mp4'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  setStatus('✓ Downloaded ' + a.download, 'ok');
}

// ---------------------------------------------------------------- UI
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}
function setPill(id, cls, text) { const p = $(id); p.className = 'pill ' + cls; p.textContent = text; }
function setStatus(text, cls, file) {
  const s = $('saveStatus');
  s.textContent = text;
  s.className = 'status ' + (cls || '');
  s.title = file || text;
}

const FMT = {
  faceSize: (v) => Math.round(v * 100) + '%', faceZoom: (v) => v.toFixed(1) + '×', sZoom: (v) => v.toFixed(1) + '×',
  sPanX: (v) => Math.round(v * 100) + '%', sPanY: (v) => Math.round(v * 100) + '%', split: (v) => Math.round(v * 100) + '% screen',
  blurAmt: (v) => v, smooth: (v) => Math.round(v * 100) + '%', spots: (v) => Math.round(v * 100) + '%', even: (v) => Math.round(v * 100) + '%',
  brighten: (v) => Math.round(v * 100) + '%', sharpen: (v) => Math.round(v * 100) + '%', warmth: (v) => Math.round(v * 100) + '%',
  contrast: (v) => v.toFixed(2), saturation: (v) => v.toFixed(2), micGain: (v) => v.toFixed(1) + '×', sysGain: (v) => Math.round(v * 100) + '%',
};
const showOut = (k) => document.querySelectorAll(`[data-out="${k}"]`).forEach((b) => (b.textContent = FMT[k] ? FMT[k](S[k]) : S[k]));

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range') return parseFloat(el.value);
  if (el.dataset.type === 'int') return parseInt(el.value, 10);
  return el.value;
}

function onSetting(k) {
  if (k === 'fps') { startTicks(); fitScreenCapture(); }
  if (k === 'camRes') startCamera(S.cam);
  if (k === 'noiseSup' || k === 'echoCancel') startMic(S.mic);
  if (k === 'voiceEnhance') buildMicChain();
  if (k === 'micGain' && audio.micGain) audio.micGain.gain.value = S.micGain;
  if (k === 'sysGain' && audio.sysGain) audio.sysGain.gain.value = S.sysGain;
  updateVisibility();
}

function syncControls() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = S[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    showOut(el.dataset.key);
  });
  document.querySelectorAll('#formatSeg button').forEach((b) => b.classList.toggle('active', b.dataset.format === S.format));
  document.querySelectorAll('#bgSeg button').forEach((b) => b.classList.toggle('active', b.dataset.bg === S.bg));
  const res = $('res');
  res.innerHTML = '';
  RES[S.format].forEach(([v, t]) => res.append(new Option(t, v)));
  res.value = isVert() ? S.resVert : S.resLand;
  $('screenFit').value = screenFit();
  renderLayoutButtons();
  updateVisibility();
}

function renderLayoutButtons() {
  const seg = $('layoutSeg');
  seg.innerHTML = '';
  LAYOUTS[S.format].forEach(([v, t], i) => {
    const b = document.createElement('button');
    b.innerHTML = `${t}<small>${i + 1}</small>`;
    b.classList.toggle('active', v === layout());
    b.onclick = () => setLayout(v);
    seg.append(b);
  });
  if (mini) renderMiniScenes();
}

function setLayout(v) {
  if (isVert()) S.layoutVert = v; else S.layoutLand = v;
  saveSettings();
  renderLayoutButtons();
  updateVisibility();
}

function updateVisibility() {
  const lay = layout();
  const show = {
    hasScreen: lay !== 'face', hasFace: lay !== 'screen', stack: lay === 'stack', bubble: lay === 'bubble',
    blur: S.bg === 'blur', color: S.bg === 'color',
  };
  document.querySelectorAll('[data-show]').forEach((el) => (el.hidden = !show[el.dataset.show]));
}

function updateUI() {
  const st = rec.state, busy = st !== 'idle';
  const recBtn = $('btnRec');
  recBtn.classList.toggle('recording', st === 'recording' || st === 'paused');
  $('recLabel').textContent = st === 'idle' ? 'Record' : st === 'countdown' ? 'Starting…' : st === 'saving' ? 'Saving…' : 'Stop';
  recBtn.disabled = st === 'countdown' || st === 'saving';
  $('btnPause').disabled = !(st === 'recording' || st === 'paused');
  $('btnPause').textContent = st === 'paused' ? 'Resume' : 'Pause';
  $('btnStop').disabled = !(st === 'recording' || st === 'paused');
  document.querySelectorAll('#formatSeg button, #res, [data-key="fps"], [data-key="quality"]').forEach((el) => (el.disabled = busy));
  if (mini) {
    mini.rec.textContent = st === 'idle' ? '● Record' : '■ Stop';
    mini.rec.disabled = recBtn.disabled;
    mini.pause.disabled = $('btnPause').disabled;
    mini.pause.textContent = st === 'paused' ? '▶' : '❚❚';
  }
  timerTick();
}

function timerTick() {
  const ms = rec.elapsed + (rec.state === 'recording' ? performance.now() - rec.segStart : 0);
  const s = Math.floor(ms / 1000);
  const txt = `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const live = rec.state === 'recording' || rec.state === 'paused';
  $('timer').textContent = live || rec.state === 'saving' ? txt : '00:00';
  $('timer').classList.toggle('live', rec.state === 'recording');
  if (mini && rec.state !== 'countdown') { mini.timer.textContent = live ? (rec.state === 'paused' ? '❚❚ ' : '● ') + txt : 'Ready'; mini.timer.classList.toggle('live', rec.state === 'recording'); }
}

// Floating mini controller (Document Picture-in-Picture)
let mini = null;
async function openMini() {
  if (mini) { mini.win.focus(); return; }
  if (!('documentPictureInPicture' in window)) { toast('Mini controls need Chrome or Edge 116+.'); return; }
  const win = await documentPictureInPicture.requestWindow({ width: 360, height: 118 });
  const d = win.document;
  d.head.append(Object.assign(d.createElement('link'), { rel: 'stylesheet', href: new URL('style.css', location.href).href }));
  d.title = 'Recorder';
  d.body.className = 'mini';
  d.body.innerHTML = `<div class="mini-row"><button class="btn rec" id="mRec">● Record</button><button class="btn" id="mPause">❚❚</button>
    <span class="timer" id="mTimer">Ready</span></div><div class="mini-scenes" id="mScenes"></div>`;
  mini = { win, rec: d.getElementById('mRec'), pause: d.getElementById('mPause'), timer: d.getElementById('mTimer'), scenes: d.getElementById('mScenes') };
  mini.rec.onclick = () => (rec.state === 'idle' ? startRecording() : stopRecording());
  mini.pause.onclick = togglePause;
  d.addEventListener('keydown', onKey);
  win.addEventListener('pagehide', () => (mini = null));
  renderMiniScenes();
  updateUI();
}
function renderMiniScenes() {
  mini.scenes.innerHTML = '';
  LAYOUTS[S.format].forEach(([v, t]) => {
    const b = mini.win.document.createElement('button');
    b.textContent = t;
    b.classList.toggle('active', v === layout());
    b.onclick = () => setLayout(v);
    mini.scenes.append(b);
  });
}

function onKey(e) {
  if (e.target.matches?.('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); rec.state === 'idle' ? startRecording() : stopRecording(); }
  else if (k === 'p') togglePause();
  else if (/^[1-4]$/.test(k)) setLayout(LAYOUTS[S.format][+k - 1][0]);
}

// Drag the face bubble / pan a zoomed screen directly on the preview.
let drag = null;
const toCanvas = (e) => { const r = out.getBoundingClientRect(); return { x: ((e.clientX - r.left) * out.width) / r.width, y: ((e.clientY - r.top) * out.height) / r.height }; };
const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const canPan = () => S.sZoom > 1.01 || screenFit() === 'cover';
out.addEventListener('pointerdown', (e) => {
  const p = toCanvas(e);
  if (inside(p, hit.bubble)) drag = { kind: 'bubble', dx: p.x - (hit.bubble.x + hit.bubble.w / 2), dy: p.y - (hit.bubble.y + hit.bubble.h / 2) };
  else if (inside(p, hit.screen) && canPan()) drag = { kind: 'pan', x: p.x, y: p.y, px: S.sPanX, py: S.sPanY, w: hit.screen.w, h: hit.screen.h };
  if (drag) { out.setPointerCapture(e.pointerId); e.preventDefault(); }
});
out.addEventListener('pointermove', (e) => {
  const p = toCanvas(e);
  if (!drag) { out.style.cursor = inside(p, hit.bubble) ? 'grab' : inside(p, hit.screen) && canPan() ? 'move' : 'default'; return; }
  if (drag.kind === 'bubble') {
    const pos = bubblePos();
    pos.x = clamp((p.x - drag.dx) / out.width, 0, 1);
    pos.y = clamp((p.y - drag.dy) / out.height, 0, 1);
  } else {
    S.sPanX = clamp(drag.px - (p.x - drag.x) / drag.w, 0, 1);
    S.sPanY = clamp(drag.py - (p.y - drag.y) / drag.h, 0, 1);
  }
});
out.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  saveSettings();
  ['sPanX', 'sPanY'].forEach((k) => { document.querySelector(`[data-key="${k}"]`).value = S[k]; showOut(k); });
});
out.addEventListener('wheel', (e) => {
  if (!inside(toCanvas(e), hit.bubble)) return;
  e.preventDefault();
  S.faceSize = clamp(S.faceSize * (e.deltaY < 0 ? 1.06 : 0.94), 0.12, 0.7);
  document.querySelector('[data-key="faceSize"]').value = S.faceSize;
  showOut('faceSize');
  saveSettings();
}, { passive: false });

// ---------------------------------------------------------------- wiring
function bind() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const evt = el.type === 'range' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(evt, () => { S[el.dataset.key] = readControl(el); saveSettings(); showOut(el.dataset.key); onSetting(el.dataset.key); });
  });
  document.querySelectorAll('#formatSeg button').forEach((b) => (b.onclick = () => { S.format = b.dataset.format; saveSettings(); syncControls(); fitScreenCapture(); }));
  document.querySelectorAll('#bgSeg button').forEach((b) => (b.onclick = () => { S.bg = b.dataset.bg; saveSettings(); syncControls(); }));
  document.querySelectorAll('[data-pos]').forEach((b) => (b.onclick = () => {
    const [v, h] = b.dataset.pos;
    Object.assign(bubblePos(), { x: h === 'l' ? 0 : 1, y: v === 't' ? 0 : 1 });
    saveSettings();
  }));
  $('res').onchange = (e) => { if (isVert()) S.resVert = e.target.value; else S.resLand = e.target.value; saveSettings(); fitScreenCapture(); };
  $('screenFit').onchange = (e) => { if (isVert()) S.fitVert = e.target.value; else S.fitLand = e.target.value; saveSettings(); };
  $('camSel').onchange = (e) => { S.cam = e.target.value; saveSettings(); startCamera(S.cam); };
  $('micSel').onchange = (e) => { S.mic = e.target.value; saveSettings(); startMic(S.mic); };
  $('btnScreen').onclick = startScreen;
  $('btnRec').onclick = () => (rec.state === 'idle' ? startRecording() : stopRecording());
  $('btnPause').onclick = togglePause;
  $('btnStop').onclick = stopRecording;
  $('btnMini').onclick = openMini;
  $('btnFolder').onclick = () => fetch('/api/open-folder' + (rec.lastFile ? '?file=' + encodeURIComponent(rec.lastFile) : '')).catch(() => toast('Recordings folder needs the local server (start with “Studio Recorder.bat”).'));
  $('btnResetLook').onclick = () => { Object.assign(S, LOOK); saveSettings(); syncControls(); };
  document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
    if (b.dataset.preset === 'off') S.beauty = false; else Object.assign(S, BEAUTY_PRESETS[b.dataset.preset]);
    saveSettings();
    syncControls();
  }));
  const cmp = $('btnCompare');
  const hold = (v) => () => { compareHeld = v; cmp.classList.toggle('active', v); };
  cmp.addEventListener('pointerdown', hold(true));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cmp.addEventListener(ev, hold(false)));
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', () => audio.ctx?.state === 'suspended' && audio.ctx.resume(), true);
  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => {}));
  window.addEventListener('beforeunload', (e) => { if (rec.state !== 'idle') { e.preventDefault(); e.returnValue = ''; } });
}

async function main() {
  bind();
  syncControls();
  startTicks();
  setInterval(timerTick, 250);
  setInterval(meterTick, 80);
  await Promise.allSettled([startCamera(S.cam), startMic(S.mic)]);
  await refreshDevices().catch(() => {});
  try {
    const info = await (await fetch('/api/info')).json();
    $('footNote').innerHTML += ` · Saves to <b>${info.outDir}</b>`;
  } catch {
    $('footNote').innerHTML += ' · Server not running: recordings will download via the browser.';
  }
  if (cam.src && (S.bg !== 'none' || S.autoFrame || S.autoLight)) initVision();
}

// Expose a small handle for debugging from DevTools.
window.studio = { S, rec, cam, scr, vision, perf };
main();
