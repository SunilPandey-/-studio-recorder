// Frame clock + server heartbeat. Worker timers keep running at full speed
// even when the recorder window is minimized or behind other windows.
let timer = null;
let interval = 1000 / 30;
let next = 0;

function loop() {
  postMessage('tick');
  next += interval;
  const now = performance.now();
  if (next < now - interval * 2) next = now; // fell behind: resync instead of bursting
  timer = setTimeout(loop, Math.max(0, next - now));
}

onmessage = (e) => {
  const { cmd, fps } = e.data;
  clearTimeout(timer);
  timer = null;
  if (cmd === 'start') {
    interval = 1000 / fps;
    next = performance.now();
    loop();
  }
};

const ping = () => fetch('/api/ping').catch(() => {});
ping();
setInterval(ping, 15000);
