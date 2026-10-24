// Face AI off the main thread: person segmentation + face detection (MediaPipe).
// Receives small ImageBitmaps, returns a ready-to-draw RGBA alpha mask and the face box.

// MediaPipe loads its wasm glue with importScripts(), which module workers lack.
// Shim it with a synchronous fetch + global eval (allowed inside workers).
self.importScripts = (...urls) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    (0, eval)(xhr.responseText);
  }
};

const { FilesetResolver, ImageSegmenter, FaceLandmarker } = await import('./vendor/vision_bundle.mjs');

// Outline of the face (MediaPipe face mesh indices), used for the face box.
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

let seg = null, det = null, ts = 0;
let face = null, faceSeen = 0, polarity = 0, marks = null;
let prev = null, rgba = null, mw = 0, mh = 0;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const nextTs = () => (ts = Math.max(performance.now(), ts + 1));

async function init() {
  const files = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
  const base = (path, delegate) => ({ modelAssetPath: new URL(path, import.meta.url).href, delegate });
  for (const delegate of ['GPU', 'CPU']) {
    try {
      seg = await ImageSegmenter.createFromOptions(files, {
        baseOptions: base('./vendor/models/selfie_segmenter.tflite', delegate),
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      });
      det = await FaceLandmarker.createFromOptions(files, {
        baseOptions: base('./vendor/models/face_landmarker.task', delegate),
        runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      return delegate;
    } catch (e) {
      console.warn(`Face AI on ${delegate} failed`, e);
    }
  }
  throw new Error('could not start face AI');
}

function buildMask(data, w, h) {
  if (w !== mw || h !== mh) {
    mw = w; mh = h;
    prev = new Float32Array(w * h);
    rgba = null;
  }
  if (!rgba) { rgba = new Uint8ClampedArray(w * h * 4); rgba.fill(255); }
  // Decide which side of the mask is the person (face / centre vs. top corners).
  const at = (x, y) => data[Math.round(clamp(y, 0, 1) * (h - 1)) * w + Math.round(clamp(x, 0, 1) * (w - 1))];
  const pv = face ? at(face.cx, face.cy) : (at(0.5, 0.6) + at(0.5, 0.78)) / 2;
  const bv = (at(0.03, 0.03) + at(0.97, 0.03)) / 2;
  if (Math.abs(pv - bv) > 0.4) polarity = clamp(polarity + (pv > bv ? 1 : -1), -30, 30);
  const inv = polarity < 0;
  for (let i = 0; i < data.length; i++) {
    const v = prev[i] * 0.35 + (inv ? 1 - data[i] : data[i]) * 0.65; // temporal smoothing against flicker
    prev[i] = v;
    const t = clamp((v - 0.25) / 0.5, 0, 1);
    rgba[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
  }
  const out = rgba;
  rgba = null; // transferred to the main thread; a fresh buffer is made next time
  return out;
}

function process({ bitmap, doSeg, doFace }) {
  const now = performance.now();
  const res = { face: undefined, mask: null, marks: undefined };
  try {
    if (doFace) {
      const pts = det.detectForVideo(bitmap, nextTs()).faceLandmarks?.[0];
      if (pts) {
        // 478 landmarks (normalized), lightly smoothed against jitter.
        if (!marks || now - faceSeen > 500) marks = new Float32Array(pts.length * 2).map((_, i) => (i & 1 ? pts[i >> 1].y : pts[i >> 1].x));
        else for (let i = 0; i < pts.length; i++) { marks[i * 2] = lerp(marks[i * 2], pts[i].x, 0.6); marks[i * 2 + 1] = lerp(marks[i * 2 + 1], pts[i].y, 0.6); }
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const i of FACE_OVAL) {
          x0 = Math.min(x0, marks[i * 2]); x1 = Math.max(x1, marks[i * 2]);
          y0 = Math.min(y0, marks[i * 2 + 1]); y1 = Math.max(y1, marks[i * 2 + 1]);
        }
        const f = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
        if (!face) face = f; else for (const k in f) face[k] = lerp(face[k], f[k], 0.35);
        faceSeen = now;
        res.marks = marks.slice();
      } else if (face && now - faceSeen > 1500) { face = null; marks = null; res.marks = null; }
      res.face = face && { ...face };
    }
    if (doSeg) {
      seg.segmentForVideo(bitmap, nextTs(), (r) => {
        const m = r.confidenceMasks?.[0];
        if (m) res.mask = { data: buildMask(m.getAsFloat32Array(), m.width, m.height), w: m.width, h: m.height };
      });
    }
  } finally {
    bitmap.close();
  }
  return res;
}

onmessage = (e) => {
  if (e.data.cmd === 'reset') { face = null; marks = null; polarity = 0; mw = mh = 0; return; }
  let res = {};
  try {
    res = process(e.data);
  } catch (err) {
    console.warn('face AI frame error', err);
  }
  postMessage(res, [res.mask?.data.buffer, res.marks?.buffer].filter(Boolean)); // always answer so the main thread never stalls
};

try {
  postMessage({ ready: await init() });
} catch (e) {
  postMessage({ error: e.message });
}
