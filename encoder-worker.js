// Recording back-end, off the main thread: encodes audio (Opus) straight from the mixer track,
// muxes it with the H.264 chunks the page sends (the page keeps the video encoder, because GPU
// canvas frames are cheapest to encode where they are drawn) into a fragmented MP4, and streams
// the file to disk through the local server.
import { Muxer, StreamTarget } from './vendor/mp4-muxer.mjs';
import { Sink } from './sink.js';

let st = null;
const absNow = () => performance.timeOrigin + performance.now();
// Recording timeline in microseconds: wall time minus paused time, same as the page's.
const timelineUs = () => Math.round((st.elapsed + (st.paused ? 0 : absNow() - st.segStart)) * 1000);

async function start(m) {
  const sink = new Sink(m.id);
  const audioCfg = m.audio && { codec: 'opus', sampleRate: m.sampleRate, numberOfChannels: 2, bitrate: 256000 };
  const withAudio = !!audioCfg && (await AudioEncoder.isConfigSupported(audioCfg).catch(() => ({}))).supported;
  const muxer = new Muxer({
    target: new StreamTarget({ onData: (data, pos) => sink.write(data, pos) }),
    video: { codec: 'avc', width: m.width, height: m.height, frameRate: m.fps },
    audio: withAudio ? { codec: 'opus', numberOfChannels: 2, sampleRate: m.sampleRate } : undefined,
    fastStart: 'fragmented',
    firstTimestampBehavior: 'cross-track-offset',
  });
  st = { sink, muxer, closed: false, paused: false, elapsed: 0, segStart: m.startAbs, aNext: null, aLastRaw: null };
  if (withAudio) {
    st.aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => postMessage({ error: e.message }) });
    st.aenc.configure(audioCfg);
    st.reader = m.audio.getReader();
    pumpAudio(st);
  } else {
    m.audio?.cancel().catch(() => {});
  }
  postMessage({ started: true, audio: withAudio });
}

// Audio is laid end-to-end by sample count (no drift, nothing lost here in the worker). If the
// capture clock shows a real forward jump (dropped chunk), skip ahead by that much so sound stays
// in sync; the server fills such gaps with silence.
async function pumpAudio(s) {
  for (;;) {
    const { value: ad, done } = await s.reader.read().catch(() => ({ done: true }));
    if (done || s.closed) { ad?.close(); return; }
    const raw = ad.timestamp, dur = ad.duration;
    const gap = s.aLastRaw === null ? 0 : raw - s.aLastRaw - dur;
    s.aLastRaw = raw;
    if (s.paused || ad.numberOfChannels !== 2) { ad.close(); continue; }
    if (s.aNext === null || s.resumed) {
      // (Re)start: place this chunk so it ends "now" on the recording timeline.
      s.aNext = Math.max(s.aNext ?? 0, timelineUs() - dur);
      s.resumed = false;
    } else if (gap > dur * 0.5 && gap < 5e6) {
      s.aNext += gap;
    }
    const out = restamp(ad, Math.max(0, Math.round(s.aNext)));
    try { s.aenc.encode(out); } catch (e) { console.warn(e); }
    out.close();
    s.aNext += dur;
    ad.close();
  }
}

function restamp(ad, timestamp) {
  const planes = ad.format.endsWith('-planar') ? ad.numberOfChannels : 1;
  const sizes = [];
  for (let i = 0; i < planes; i++) sizes.push(ad.allocationSize({ planeIndex: i }));
  const buf = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  for (let i = 0, off = 0; i < planes; off += sizes[i++]) ad.copyTo(buf.subarray(off, off + sizes[i]), { planeIndex: i });
  return new AudioData({ format: ad.format, sampleRate: ad.sampleRate, numberOfFrames: ad.numberOfFrames, numberOfChannels: ad.numberOfChannels, timestamp, data: buf });
}

async function stop() {
  const s = st;
  s.closed = true;
  await s.reader?.cancel().catch(() => {});
  try { if (s.aenc) await s.aenc.flush(); } catch (e) { console.warn(e); }
  s.aenc?.close();
  s.muxer.finalize();
  s.sink.flush();
  await s.sink.queue;
  const blob = s.sink.mem ? await s.sink.toBlob('video/mp4') : null;
  postMessage({ done: true, failed: s.sink.failed, blob });
  st = null;
}

onmessage = ({ data: m }) => {
  try {
    if (m.cmd === 'video' && st && !st.closed) st.muxer.addVideoChunk(m.chunk, m.meta);
    else if (m.cmd === 'start') start(m).catch((e) => postMessage({ error: e.message }));
    else if (m.cmd === 'pause' && st) { st.elapsed += m.at - st.segStart; st.paused = true; }
    else if (m.cmd === 'resume' && st) { st.segStart = m.at; st.paused = false; st.resumed = true; }
    else if (m.cmd === 'stop' && st) stop().catch((e) => postMessage({ error: e.message, done: true }));
  } catch (e) {
    postMessage({ error: e.message });
  }
};
