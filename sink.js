// Streams (position, bytes) writes to the local server in ~2 MB batches,
// or keeps them in memory when the server is not running (id === null).
export class Sink {
  constructor(id) {
    Object.assign(this, { id, parts: [], start: 0, len: 0, offset: 0, queue: Promise.resolve(), failed: false, mem: id ? null : [] });
  }

  write(data, pos) {
    if (this.len && pos !== this.start + this.len) this.flush();
    if (!this.len) this.start = pos;
    this.parts.push(data.slice());
    this.len += data.byteLength;
    if (this.len >= 2 << 20) this.flush();
  }

  append(blob) {
    this.send(blob, this.offset);
    this.offset += blob.size;
  }

  flush() {
    if (!this.len) return;
    this.send(new Blob(this.parts), this.start);
    this.parts = [];
    this.len = 0;
  }

  send(blob, pos) {
    if (this.mem) { this.mem.push({ pos, blob }); return; }
    this.queue = this.queue.then(() => this.post(blob, pos));
  }

  async post(blob, pos) {
    for (let i = 0; i < 4; i++) {
      try {
        if ((await fetch(`/api/chunk?id=${this.id}&pos=${pos}`, { method: 'POST', body: blob })).ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    this.failed = true;
  }

  async toBlob(type) {
    let size = 0;
    for (const c of this.mem) size = Math.max(size, c.pos + c.blob.size);
    const buf = new Uint8Array(size);
    for (const c of this.mem) buf.set(new Uint8Array(await c.blob.arrayBuffer()), c.pos);
    return new Blob([buf], { type });
  }
}
