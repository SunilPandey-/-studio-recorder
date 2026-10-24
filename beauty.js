// GPU face beautification (WebGL2), applied to the camera frame before compositing:
//  - frequency separation: soften pores / uneven texture, keep a little natural grain
//  - spot removal: small dark dips (spots, acne marks, dark patches) are lifted to the
//    brightness and colour of the surrounding skin; deep shadows (nostrils, eye corners) are left alone
//  - even tone, brighten, and sharpening of non-skin detail (eyes, brows, hair)
// Everything is limited to a skin mask built from MediaPipe face landmarks plus a skin-colour test.

const VS = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 9-tap Gaussian (sigma ~2 steps) using 5 linear-filtered fetches.
const BLUR = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D t; uniform vec2 dir;
void main() {
  vec4 c = texture(t, uv) * 0.2270270270;
  c += (texture(t, uv + dir * 1.3846153846) + texture(t, uv - dir * 1.3846153846)) * 0.3162162162;
  c += (texture(t, uv + dir * 3.2307692308) + texture(t, uv - dir * 3.2307692308)) * 0.0702702703;
  o = c;
}`;

// Grey-scale dilation (max) / erosion (min) along one direction; dilate-then-erode = "closing",
// which fills in dark features smaller than the reach (spots, acne marks, small dark patches).
const MORPH = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D t; uniform vec2 dir; uniform int mode; uniform int lumaIn;
void main() {
  float v = mode == 0 ? 0.0 : 1.0;
  for (int i = -4; i <= 4; i++) {
    vec4 s = texture(t, uv + dir * float(i));
    float l = lumaIn == 1 ? dot(s.rgb, vec3(0.299, 0.587, 0.114)) : s.r;
    v = mode == 0 ? max(v, l) : min(v, l);
  }
  o = vec4(v, v, v, 1.0);
}`;

// Top-hat amount (how far below the closed surface), used to measure how dense dark detail is nearby.
const TOPHAT = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D closeT, b1;
void main() {
  float v = max(texture(closeT, uv).r - dot(texture(b1, uv).rgb, vec3(0.299, 0.587, 0.114)), 0.0);
  o = vec4(v, v, v, 1.0);
}`;

const FINAL = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D src, b1, b2, mask, closeT, densT;
uniform float smoothAmt, spots, even, bright, sharpen, showMask;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  vec3 c = texture(src, p).rgb;
  vec3 s1 = texture(b1, p).rgb;   // fine blur  (~pore scale)
  vec3 s2 = texture(b2, p).rgb;   // coarse blur (larger than a spot)
  float m = texture(mask, p).r;

  // Skin-colour likelihood (YCbCr), so hair, glasses and background inside the outline are spared.
  float cb = 0.5 - 0.168736 * s1.r - 0.331264 * s1.g + 0.5 * s1.b;
  float cr = 0.5 + 0.5 * s1.r - 0.418688 * s1.g - 0.081312 * s1.b;
  float skinC = smoothstep(0.50, 0.53, cr) * (1.0 - smoothstep(0.69, 0.73, cr))
              * smoothstep(0.26, 0.30, cb) * (1.0 - smoothstep(0.51, 0.55, cb));
  float skin = clamp(m * mix(0.25, 1.0, skinC), 0.0, 1.0);

  // 1) frequency separation smoothing
  vec3 base = s1 + (c - s1) * (1.0 - 0.85 * smoothAmt);

  // 2) spot / dark-patch removal (black top-hat): how much darker this point is than the
  //    "closed" surface where every small dark feature has been filled in.
  float lb = luma(base);
  float th = texture(closeT, p).r - lb;
  // Spots are isolated; hair, brows and stubble are dense dark detail: leave those alone.
  float dens = texture(densT, p).r;
  float spotW = spots * smoothstep(0.01, 0.05, th) * (1.0 - smoothstep(0.22, 0.34, th)) * smoothstep(0.0, 0.5, m)
              * mix(0.3, 1.0, skinC) * (1.0 - smoothstep(0.03, 0.065, dens));
  vec3 lifted = base * min((lb + th) / max(lb, 0.02), 1.7);
  lifted = mix(lifted, s2 * (luma(lifted) / max(luma(s2), 0.02)), 0.5); // and take the surrounding skin colour
  base = mix(base, lifted, clamp(spotW * 1.1, 0.0, 1.0));

  // 3) even tone: pull colour towards the local average (blotches, redness)
  vec3 toned = s2 * (luma(base) / max(luma(s2), 0.02));
  base = mix(base, toned, clamp(even * 0.5, 0.0, 1.0));

  // 4) gentle brightening / glow
  base += bright * 0.12 * (1.0 - base);

  vec3 outc = mix(c, base, skin);
  // 5) sharpen everything that is not skin (eyes, brows, lashes, hair, clothes)
  outc += (c - s1) * sharpen * 0.9 * (1.0 - skin);
  outc = mix(outc, vec3(0.1, 1.0, 0.3), showMask * skin * 0.45);
  o = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// MediaPipe face mesh outlines.
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const HOLES = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], // left eye
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466], // right eye
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], // left brow
  [300, 293, 334, 296, 336, 285, 295, 282, 283, 276], // right brow
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185], // lips
];

export class Beauty {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    this.ok = !!gl;
    if (!gl) return;
    this.gl = gl;
    this.blur = this.program(BLUR);
    this.final = this.program(FINAL);
    this.morph = this.program(MORPH);
    this.tophat = this.program(TOPHAT);
    this.tex = { src: this.texture(), mask: this.texture() };
    this.targets = {};
    this.maskCanvas = Object.assign(document.createElement('canvas'), { width: 256, height: 144 });
    this.holeCanvas = Object.assign(document.createElement('canvas'), { width: 256, height: 144 });
    this.vao = gl.createVertexArray();
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
    return { p, loc };
  }

  texture() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  target(name, w, h) {
    const gl = this.gl;
    let t = this.targets[name];
    if (!t || t.w !== w || t.h !== h) {
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = this.targets[name] = { tex, fb, w, h };
    }
    return t;
  }

  pass(prog, out, w, h, bind) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    bind(prog.loc);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  blurPass(input, out, dx, dy) {
    const gl = this.gl;
    this.pass(this.blur, out, out.w, out.h, (loc) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(loc.t, 0);
      gl.uniform2f(loc.dir, dx, dy);
    });
  }

  morphPass(input, out, dx, dy, mode, lumaIn) {
    const gl = this.gl;
    this.pass(this.morph, out, out.w, out.h, (loc) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(loc.t, 0);
      gl.uniform2f(loc.dir, dx, dy);
      gl.uniform1i(loc.mode, mode);
      gl.uniform1i(loc.lumaIn, lumaIn);
    });
  }

  // Skin area = face outline (stretched up over the forehead) minus eyes, brows and lips, feathered.
  buildMask(marks, aspect) {
    const W = 256, H = Math.max(16, Math.round(W / aspect));
    const hole = this.holeCanvas, m = this.maskCanvas;
    if (hole.height !== H) { hole.height = H; m.height = H; }
    const x = (i) => marks[i * 2] * W, y = (i) => marks[i * 2 + 1] * H;
    let cx = 0, cy = 0, y0 = H, y1 = 0, x0 = W, x1 = 0;
    for (const i of OVAL) { cx += x(i); cy += y(i); y0 = Math.min(y0, y(i)); y1 = Math.max(y1, y(i)); x0 = Math.min(x0, x(i)); x1 = Math.max(x1, x(i)); }
    cx /= OVAL.length; cy /= OVAL.length;
    const half = (y1 - y0) / 2, faceW = x1 - x0;
    const c = hole.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#fff';
    c.beginPath();
    OVAL.forEach((i, k) => {
      const up = Math.max(0, Math.min(1, (cy - y(i)) / half));
      const s = 1 + 0.3 * up * up; // the mesh outline stops below the hairline: reach up the forehead
      const px = cx + (x(i) - cx) * s, py = cy + (y(i) - cy) * s;
      k ? c.lineTo(px, py) : c.moveTo(px, py);
    });
    c.closePath();
    c.fill();
    c.fillStyle = c.strokeStyle = '#000';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, faceW * 0.05);
    for (const poly of HOLES) {
      c.beginPath();
      poly.forEach((i, k) => (k ? c.lineTo(x(i), y(i)) : c.moveTo(x(i), y(i))));
      c.closePath();
      c.fill();
      c.stroke();
    }
    const mc = m.getContext('2d');
    mc.filter = `blur(${Math.max(1.5, faceW * 0.03).toFixed(1)}px)`;
    mc.drawImage(hole, 0, 0);
    mc.filter = 'none';
    return m;
  }

  /**
   * @param img camera frame (VideoFrame / video), w,h its size
   * @param marks Float32Array of normalized landmark x,y pairs
   * @param faceW face width in source pixels (sets the spot / smoothing scale)
   */
  process(img, w, h, marks, faceW, opt) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.bindTexture(gl.TEXTURE_2D, this.tex.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.buildMask(marks, w / h));

    // Blur scales follow face size: fine ~ pores (faceW/60), coarse ~ larger than a spot (faceW/12).
    const w2 = Math.max(8, w >> 1), h2 = Math.max(8, h >> 1);
    const w4 = Math.max(4, w >> 2), h4 = Math.max(4, h >> 2);
    const w8 = Math.max(4, w >> 3), h8 = Math.max(4, h >> 3);
    const s1 = Math.min(2, Math.max(0.5, faceW / 60 / 4));
    const s2 = Math.min(1.6, Math.max(0.6, faceW / 12 / 16));
    const a = this.target('a2', w2, h2), b1 = this.target('b2', w2, h2);
    const q1 = this.target('a4', w4, h4), q2 = this.target('b4', w4, h4);
    const e1 = this.target('a8', w8, h8), b2 = this.target('b8', w8, h8);
    this.blurPass(this.tex.src, a, (s1 * 2) / w, 0);
    this.blurPass(a.tex, b1, 0, s1 / h2);
    this.blurPass(b1.tex, q1, 1 / w2, 0);
    this.blurPass(q1.tex, q2, 0, 1 / h4);
    this.blurPass(q2.tex, e1, s2 / w4, 0);
    this.blurPass(e1.tex, b2, 0, s2 / h8);

    // Closing at half resolution; reach ~ faceW/10 covers spots and small patches but not
    // larger facial structure (nose / eye-socket shadows, face outline).
    const step = Math.max(1, faceW / 10 / 2 / 4);
    const c1 = this.target('c1', w2, h2), c2 = this.target('c2', w2, h2);
    this.morphPass(b1.tex, c1, step / w2, 0, 0, 1);
    this.morphPass(c1.tex, c2, 0, step / h2, 0, 0);
    this.morphPass(c2.tex, c1, step / w2, 0, 1, 0);
    this.morphPass(c1.tex, c2, 0, step / h2, 1, 0);
    this.blurPass(c2.tex, c1, 1 / w2, 0);
    this.blurPass(c1.tex, c2, 0, 1 / h2);
    // density of dark detail over roughly a spot-sized-x3 neighbourhood
    const d1 = this.target('d1', w4, h4), d2 = this.target('d2', w4, h4);
    this.pass(this.tophat, d1, w4, h4, (loc) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, c2.tex); gl.uniform1i(loc.closeT, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b1.tex); gl.uniform1i(loc.b1, 1);
    });
    const ds = Math.max(1, faceW / 14 / 4 / 2);
    this.blurPass(d1.tex, d2, ds / w4, 0);
    this.blurPass(d2.tex, d1, 0, ds / h4);

    this.pass(this.final, null, w, h, (loc) => {
      [[this.tex.src, 'src'], [b1.tex, 'b1'], [b2.tex, 'b2'], [this.tex.mask, 'mask'], [c2.tex, 'closeT'], [d1.tex, 'densT']].forEach(([t, name], i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(loc[name], i);
      });
      gl.uniform1f(loc.smoothAmt, opt.smooth);
      gl.uniform1f(loc.spots, opt.spots);
      gl.uniform1f(loc.even, opt.even);
      gl.uniform1f(loc.bright, opt.brighten);
      gl.uniform1f(loc.sharpen, opt.sharpen);
      gl.uniform1f(loc.showMask, opt.showMask ? 1 : 0);
    });
    return this.canvas;
  }
}
