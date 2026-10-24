const $ = (id) => document.getElementById(id);
const LAYOUTS = {
  land: [['side', 'Side by side'], ['bubble', 'Screen + Face'], ['face', 'Face only'], ['screen', 'Screen only']],
  vert: [['stack', 'Stacked'], ['bubble', 'Screen + Face'], ['face', 'Face only'], ['screen', 'Screen only']],
};
const DEFAULTS = {
  format: 'land', layoutLand: 'side', layoutVert: 'stack', zoom: 1.0, shape: 'circle', size: 0.3, corner: 'br',
  border: true, split: 0.5, fitLand: 'contain', fitSide: 'cover', fitVert: 'cover', faceWidth: 0.26, trimBorders: true, screenZoom: 1, panX: 0.5, panY: 0.5, audio: 'face',
  trimStart: '', trimEnd: '',
};
const KEY = 'studioRecorder.combine.v1';
const P = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch { /* ignore */ } };
const vert = () => P.format === 'vert';
const layout = () => (vert() ? P.layoutVert : P.layoutLand);
const fitKey = () => (vert() ? 'fitVert' : layout() === 'side' ? 'fitSide' : 'fitLand');
let analysis = null, offset = 0, jobId = null;

const pct = (v) => Math.round(v * 100) + '%';
const FMT = { faceWidth: pct, zoom: (v) => (+v).toFixed(2) + '×', size: pct, split: (v) => pct(v) + ' screen', screenZoom: (v) => (+v).toFixed(1) + '×', panX: pct, panY: pct };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 6000);
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function params() {
  const fit = document.querySelector('[data-key="fit"]').value;
  return {
    facePath: $('facePath').value.trim() || $('faceSel').value,
    screenPath: $('screenPath').value.trim() || $('screenSel').value,
    format: P.format, layout: layout(), zoom: +P.zoom, shape: P.shape, size: +P.size, corner: P.corner, border: P.border,
    split: +P.split, fit, faceWidth: +P.faceWidth, trimBorders: P.trimBorders, screenZoom: +P.screenZoom, panX: +P.panX, panY: +P.panY, audio: P.audio, offset,
    trimStart: +P.trimStart || 0, trimEnd: +P.trimEnd || 0, at: +$('at').value,
  };
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r;
}

// ---------------------------------------------------------------- files + analysis
async function loadFiles() {
  const { face, screen } = await (await fetch('/api/combine/files')).json();
  const fill = (sel, list) => {
    sel.innerHTML = '';
    list.forEach((f) => sel.append(new Option(`${new Date(f.mtime * 1000).toLocaleString()} · ${f.name} (${f.mb} MB)`, f.path)));
    if (!list.length) sel.append(new Option('No recordings found — paste a path below', ''));
  };
  fill($('faceSel'), face);
  fill($('screenSel'), screen.filter((f) => !/_Combined_/.test(f.path)));
}

async function analyze() {
  const p = params();
  if (!p.facePath || !p.screenPath) { toast('Pick both recordings first.'); return; }
  $('btnAnalyze').disabled = true;
  $('syncInfo').textContent = 'Syncing sound and finding your face…';
  try {
    analysis = await (await post('/api/combine/analyze', p)).json();
    offset = analysis.offset;
    $('offset').value = offset.toFixed(2);
    $('nudgeRow').hidden = false;
    const conf = analysis.syncConfidence;
    const how = offset >= 0 ? `the screen recording started ${offset.toFixed(2)} s earlier` : `Zoom started ${(-offset).toFixed(2)} s earlier`;
    $('syncInfo').innerHTML = conf >= 2.5
      ? `✓ Synced: ${how}.`
      : `⚠ Sync unsure (${how}). Check lips vs. sound in the preview and adjust the offset.`;
    if (!analysis.faceBox) $('syncInfo').innerHTML += '<br>⚠ No face found in the Zoom video — framing is centred.';
    const dur = Math.max(1, Math.min(analysis.screen.duration - Math.max(0, offset), analysis.face.duration - Math.max(0, -offset)));
    $('at').max = Math.floor(dur);
    $('at').value = Math.min(5, Math.floor(dur / 2));
    $('btnRender').disabled = false;
    $('placeholder').hidden = true;
    preview();
  } catch (e) {
    $('syncInfo').textContent = 'Could not analyse: ' + e.message;
  } finally {
    $('btnAnalyze').disabled = false;
  }
}

// ---------------------------------------------------------------- preview (debounced, latest wins)
let pvTimer = null, pvSeq = 0;
function preview() {
  if (!analysis) return;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(async () => {
    const seq = ++pvSeq;
    $('wrap').classList.add('loading');
    try {
      const blob = await (await post('/api/combine/preview', params())).blob();
      if (seq !== pvSeq) return;
      const img = $('preview');
      URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
    } catch (e) {
      if (seq === pvSeq) toast('Preview failed: ' + e.message);
    } finally {
      if (seq === pvSeq) $('wrap').classList.remove('loading');
    }
  }, 250);
}

// ---------------------------------------------------------------- render
async function render() {
  try {
    jobId = (await (await post('/api/combine/render', params())).json()).id;
  } catch (e) { toast(e.message); return; }
  $('btnRender').disabled = true;
  $('btnCancel').hidden = false;
  $('status').className = 'status';
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const j = await (await fetch(`/api/combine/status?id=${jobId}`)).json();
    $('bar').style.width = (j.progress || 0) * 100 + '%';
    $('status').textContent = j.state === 'rendering' ? `Creating… ${Math.round((j.progress || 0) * 100)}%` : '';
    if (j.state === 'done') {
      $('status').textContent = '✓ Saved ' + j.file.split(/[\\/]/).pop();
      $('status').className = 'status ok';
      $('status').title = j.file;
      $('btnFolder').dataset.file = j.file;
      break;
    }
    if (j.state === 'error') {
      $('status').textContent = 'Failed';
      $('status').className = 'status warn';
      toast(j.error);
      break;
    }
  }
  $('btnRender').disabled = false;
  $('btnCancel').hidden = true;
}

// ---------------------------------------------------------------- controls
function renderLayoutButtons() {
  const seg = $('layoutSeg');
  seg.innerHTML = '';
  LAYOUTS[P.format].forEach(([v, t]) => {
    const b = document.createElement('button');
    b.textContent = t;
    b.classList.toggle('active', v === layout());
    b.onclick = () => { if (vert()) P.layoutVert = v; else P.layoutLand = v; save(); sync(); preview(); };
    seg.append(b);
  });
}

function sync() {
  document.querySelectorAll('#formatSeg button').forEach((b) => b.classList.toggle('active', b.dataset.format === P.format));
  renderLayoutButtons();
  document.querySelectorAll('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    const v = k === 'fit' ? P[fitKey()] : P[k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    document.querySelectorAll(`[data-out="${k}"]`).forEach((o) => (o.textContent = FMT[k] ? FMT[k](v) : v));
  });
  const lay = layout();
  const show = { bubble: lay === 'bubble', stack: lay === 'stack', side: lay === 'side', hasScreen: lay !== 'face' };
  document.querySelectorAll('[data-show]').forEach((el) => (el.hidden = !show[el.dataset.show]));
}

document.querySelectorAll('[data-key]').forEach((el) => {
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const k = el.dataset.key;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'fit') P[fitKey()] = v; else P[k] = v;
    save();
    sync();
    preview();
  });
});
document.querySelectorAll('#formatSeg button').forEach((b) => (b.onclick = () => { P.format = b.dataset.format; save(); sync(); preview(); }));
document.querySelectorAll('[data-nudge]').forEach((b) => (b.onclick = () => { offset = +(offset + +b.dataset.nudge).toFixed(2); $('offset').value = offset.toFixed(2); preview(); }));
$('offset').onchange = () => { offset = +$('offset').value || 0; preview(); };
$('at').oninput = () => { $('atLabel').textContent = fmtTime(+$('at').value); preview(); };
['faceSel', 'screenSel', 'facePath', 'screenPath'].forEach((id) => ($(id).onchange = () => { analysis = null; $('btnRender').disabled = true; $('nudgeRow').hidden = true; $('syncInfo').textContent = 'Click “Sync & find face”.'; }));
$('btnAnalyze').onclick = analyze;
$('btnRender').onclick = render;
$('btnCancel').onclick = () => post('/api/combine/cancel', { id: jobId }).catch(() => {});
$('btnFolder').onclick = () => fetch('/api/open-folder' + ($('btnFolder').dataset.file ? '?file=' + encodeURIComponent($('btnFolder').dataset.file) : ''));

new Worker('tick-worker.js'); // keeps the local server alive while this page is open
sync();
$('atLabel').textContent = fmtTime(+$('at').value);
loadFiles().catch((e) => toast('Could not list recordings: ' + e.message));
