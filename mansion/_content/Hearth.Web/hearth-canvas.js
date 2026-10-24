// The engine's canvas renderer (Web 3/10 and 4/10). C# (WebHouse) paints through Hearth.View's painters into compact draw lists; this
// module plays them. Static layers (the house, its name plates) are drawn once into offscreen canvases at 2 texels per world unit and
// redrawn only when C# sends them again. requestAnimationFrame drives the game: every frame calls WebHouse.Frame once, and the camera
// and the frame's draw list come back (props, people, lights, bubbles, with marks where the house's day/night tint is multiplied in and
// where the name plates go). A figure's recoloured sheet and a tinted copy of a picture are made once per alias (see PaintList) and kept
// while they are used. Input is forwarded as is and C# (Hearth.View's HouseInput) decides what it means: one pointer taps, pans or drags a
// worker, two pointers pinch and pan, the wheel zooms about the cursor, the mouse's place shows whose name is under it, and a few keys
// (Esc, Space, 1, 2, 4) reach the game. place() puts a panel of the HTML layer beside its anchor, inside the stage. Names no game.

const TEXELS = 2;                 // texels per world unit (the house's sheets are scale 2)
const OP_RECT = 0, OP_OUTLINE = 1, OP_LINE = 2, OP_IMAGE = 3, OP_TEXT = 4, OP_POLYGON = 5, OP_GLOW = 6, OP_MARK = 7;
const MARK_TINT = 0, MARK_LABELS = 1;
const TINT_STEPS = 64;            // PaintList.TintSteps
const KEEP_FRAMES = 600;          // a tinted copy or a text unused this many frames is let go

let spriteUrl = '';
const images = new Map();         // sheet name or alias -> { img, ready, failed, waiters, used }
const pools = new Map();          // "w,h" -> the light pool's canvas
const texts = new Map();          // text key -> { canvas, w, h, base, used }
let frameNo = 0;
const layers = new Map();         // id -> layer
let canvas = null, ctx = null, dotnet = null, raf = 0, last = 0;
let background = '#7d93a8';
const stats = { frames: 0, frameMs: 0, interopMs: 0, drawMs: 0, maxMs: 0 };

let spriteQuery = '';               // "?v=" and the release (WebAssets), so a new release's pictures are not the cached old ones

export function configure(url, bg, query) {
  spriteUrl = url.endsWith('/') ? url : url + '/';
  spriteQuery = query || '';
  if (bg) background = bg;
}

export async function loadFont(family, url) {
  const face = new FontFace(family, `url(${url})`);
  await face.load();
  document.fonts.add(face);
}

// Where each word of a text starts and how wide the whole is, as Godot's text server lays out the pixel font: within a word the glyphs
// sit on half pixels, but every word's width is rounded up to a whole pixel (measured in Godot: "Lady Cecilyn huone" is 14 + 2 + 23 + 2
// + 18 = 59 at 8 px where the browser says 58). The name plates must fit the same way in both views.
function layout(c, text) {
  const words = text.split(' '), space = c.measureText(' ').width, starts = [];
  let x = 0;
  words.forEach((w, i) => {
    if (i > 0) x += space;
    starts.push(x);
    x += Math.ceil(c.measureText(w).width);
  });
  return { words, starts, width: x };
}

let measurer = null;
export function measure(text, font) {
  measurer ??= document.createElement('canvas').getContext('2d');
  measurer.font = font;
  return layout(measurer, text).width;
}

function sheet(name) {
  let s = images.get(name);
  if (s) return s;
  if (/[|*]/.test(name)) return derived(name);
  s = { img: new Image(), ready: false, failed: false, waiters: [] };
  images.set(name, s);
  s.img.onload = () => { s.ready = true; s.waiters.splice(0).forEach(f => f()); };
  s.img.onerror = () => { s.failed = true; console.error(`[ERROR] sprite sheet ${name}: ${spriteUrl}${name}.png did not load`); s.waiters.splice(0).forEach(f => f()); };
  s.img.src = `${spriteUrl}${name}.png${spriteQuery}`;
  return s;
}

// A picture made from a sheet: recoloured ("|" key>colour pairs, 0xRRGGBBAA in hex) and/or tinted ("*" r,g,b in TINT_STEPS), once the
// sheet has loaded. The pixels are changed as the Godot view recolours a figure's texture and as its Modulate multiplies the people.
function derived(name) {
  const bar = name.indexOf('|'), star = name.indexOf('*');
  const base = name.slice(0, Math.min(...[bar, star].filter(i => i >= 0)));
  const pairs = new Map();
  if (bar >= 0) name.slice(bar + 1, star >= 0 ? star : undefined).split(',').forEach(p => {
    const [from, to] = p.split('>').map(h => parseInt(h, 16) >>> 0);
    pairs.set(from, to);
  });
  const tint = star >= 0 ? name.slice(star + 1).split(',').map(v => Number(v) / TINT_STEPS) : null;
  const d = { img: document.createElement('canvas'), ready: false, failed: false, waiters: [], used: frameNo };
  images.set(name, d);
  const src = sheet(base);
  const bake = () => {
    if (src.failed) { d.failed = true; d.waiters.splice(0).forEach(f => f()); return; }
    const w = src.img.naturalWidth ?? src.img.width, h = src.img.naturalHeight ?? src.img.height;
    d.img.width = w; d.img.height = h;
    const c = d.img.getContext('2d', { willReadFrequently: true });
    c.drawImage(src.img, 0, 0);
    const data = c.getImageData(0, 0, w, h), px = data.data;
    for (let k = 0; k < px.length; k += 4) {
      if (px[k + 3] === 0) continue;
      if (pairs.size) {
        const to = pairs.get(((px[k] << 24) | (px[k + 1] << 16) | (px[k + 2] << 8) | px[k + 3]) >>> 0);
        if (to !== undefined) { px[k] = to >>> 24; px[k + 1] = (to >>> 16) & 255; px[k + 2] = (to >>> 8) & 255; px[k + 3] = to & 255; }
      }
      if (tint) { px[k] = Math.round(px[k] * tint[0]); px[k + 1] = Math.round(px[k + 1] * tint[1]); px[k + 2] = Math.round(px[k + 2] * tint[2]); }
    }
    c.putImageData(data, 0, 0);
    d.ready = true;
    d.waiters.splice(0).forEach(f => f());
  };
  if (src.ready || src.failed) bake(); else src.waiters.push(bake);
  return d;
}

// Lets go of the tinted copies and texts not drawn for a while (the light changes through dusk and dawn, and so do their keys).
function sweep() {
  for (const [k, v] of images) if (k.includes('*') && frameNo - v.used > KEEP_FRAMES) images.delete(k);
  for (const [k, v] of texts) if (frameNo - v.used > KEEP_FRAMES) texts.delete(k);
}

// The light pool of a size (GlowPool's pixels from C#), added over the frame with 'lighter'.
export function setPool(w, h, bytes) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, w * h * 4), w, h), 0, 0);
  pools.set(`${w},${h}`, cv);
}

const colour = (r, g, b, a) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

// Text as the Godot view draws its pixel font (no antialiasing): rasterized at the texel grid (the font's pixels are half a world unit
// at its size), every pixel either the colour or clear, then drawn through the context's transform (so it scales with the art). Each
// text in each colour is rasterized once and kept while it is drawn.
let scratch = null;
function text(c, s, x, y, size, rgba, font) {
  const key = `${size}|${font}|${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]}|${s}`;
  let t = texts.get(key);
  if (!t) {
    t = rasterize(s, size, rgba, font);
    texts.set(key, t);
  }
  t.used = frameNo;
  c.drawImage(t.canvas, 0, 0, t.w, t.h, x - 1, y - t.base / TEXELS, t.w / TEXELS, t.h / TEXELS);
}

function rasterize(s, size, rgba, font) {
  scratch ??= document.createElement('canvas');
  const sc = scratch.getContext('2d', { willReadFrequently: true });
  const px = size * TEXELS, f = `${px}px ${font}`;
  sc.font = `${size}px ${font}`;
  const words = layout(sc, s);
  const w = Math.max(1, Math.ceil(words.width * TEXELS) + 2 * TEXELS), h = px * 2, base = Math.round(px * 1.5);
  if (scratch.width < w || scratch.height < h) { scratch.width = Math.max(scratch.width, w); scratch.height = Math.max(scratch.height, h); }
  sc.clearRect(0, 0, scratch.width, scratch.height);
  sc.font = f;
  sc.textBaseline = 'alphabetic';
  sc.fillStyle = '#000';
  words.words.forEach((word, i) => sc.fillText(word, TEXELS + words.starts[i] * TEXELS, base));
  const img = sc.getImageData(0, 0, w, h), d = img.data;
  const [r, g, b, a] = [rgba[0] * 255, rgba[1] * 255, rgba[2] * 255, rgba[3] * 255].map(Math.round);
  for (let k = 0; k < d.length; k += 4) {
    const on = d[k + 3] >= 128;
    d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = on ? a : 0;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return { canvas, w, h, base, used: frameNo };
}

// Plays a draw list on a context whose transform maps world units to pixels.
function play(c, ops, strings, sheets, font) {
  const imgs = sheets.map(n => sheet(n));
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    switch (op) {
      case OP_RECT:
        c.fillStyle = colour(ops[i + 5], ops[i + 6], ops[i + 7], ops[i + 8]);
        c.fillRect(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4]);
        i += 9; break;
      case OP_OUTLINE:
        c.strokeStyle = colour(ops[i + 5], ops[i + 6], ops[i + 7], ops[i + 8]);
        c.lineWidth = 1;
        c.strokeRect(ops[i + 1] + 0.5, ops[i + 2] + 0.5, ops[i + 3] - 1, ops[i + 4] - 1);
        i += 9; break;
      case OP_LINE:
        c.strokeStyle = colour(ops[i + 5], ops[i + 6], ops[i + 7], ops[i + 8]);
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(ops[i + 1], ops[i + 2]); c.lineTo(ops[i + 3], ops[i + 4]); c.stroke();
        i += 9; break;
      case OP_IMAGE: {
        const s = imgs[ops[i + 1]];
        s.used = frameNo;
        if (s.ready) {
          const [sx, sy, sw, sh, dx, dy, dw, dh, flip, alpha] = ops.subarray(i + 2, i + 12);
          if (alpha < 1) c.globalAlpha = alpha;
          if (flip) {
            c.save(); c.translate(dx + dw, dy); c.scale(-1, 1);
            c.drawImage(s.img, sx, sy, sw, sh, 0, 0, dw, dh);
            c.restore();
          } else c.drawImage(s.img, sx, sy, sw, sh, dx, dy, dw, dh);
          c.globalAlpha = 1;
        }
        i += 12; break;
      }
      case OP_POLYGON: {
        const n = ops[i + 1];
        c.fillStyle = colour(ops[i + 2], ops[i + 3], ops[i + 4], ops[i + 5]);
        c.beginPath();
        for (let k = 0; k < n; k++) c[k ? 'lineTo' : 'moveTo'](ops[i + 6 + 2 * k], ops[i + 7 + 2 * k]);
        c.closePath(); c.fill();
        i += 6 + 2 * n; break;
      }
      case OP_GLOW: {
        const [x, y, w, h, alpha] = ops.subarray(i + 1, i + 6);
        const pool = pools.get(`${w},${h}`);
        if (pool) {
          c.globalCompositeOperation = 'lighter';
          c.globalAlpha = alpha;
          c.drawImage(pool, x, y, w, h);
          c.globalAlpha = 1;
          c.globalCompositeOperation = 'source-over';
        }
        i += 6; break;
      }
      case OP_MARK: {
        const t = c.getTransform();
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (ops[i + 1] === MARK_TINT) {
          const [r, g, b] = ops.subarray(i + 2, i + 5);
          if (r < 1 || g < 1 || b < 1) {
            // the day/night tint multiplies the house so far (and the sky behind it), as Godot's Modulate on the house layer
            c.globalCompositeOperation = 'multiply';
            c.fillStyle = colour(r, g, b, 1);
            c.fillRect(0, 0, c.canvas.width, c.canvas.height);
            c.globalCompositeOperation = 'source-over';
          }
        } else if (ops[i + 1] === MARK_LABELS) blit(layers.get('labels'), view[0], view[1], view[2]);
        c.setTransform(t);
        i += 5; break;
      }
      case OP_TEXT:
        text(c, strings[ops[i + 1]], ops[i + 2], ops[i + 3], ops[i + 4], ops.subarray(i + 5, i + 9), font);
        i += 9; break;
      default:
        console.error(`[ERROR] hearth-canvas: unknown op ${op} at ${i}`);
        return;
    }
  }
}

// A static layer: the draw list of the area (x0, y0, w, h) in world units, drawn once its sheets have loaded.
export function setLayer(id, bytes, strings, sheets, x0, y0, w, h, font) {
  const ops = new Float32Array(bytes.slice().buffer);
  const layer = layers.get(id) ?? { canvas: document.createElement('canvas') };
  Object.assign(layer, { ops, strings, sheets, x0, y0, w, h, font, drawn: false, version: (layer.version ?? 0) + 1 });
  layers.set(id, layer);
  const version = layer.version;
  const pending = sheets.map(n => sheet(n)).filter(s => !s.ready && !s.failed);
  const draw = () => { if (layer.version === version) renderLayer(layer); };
  if (pending.length === 0) draw();
  else {
    let left = pending.length;
    pending.forEach(s => s.waiters.push(() => { if (--left === 0) draw(); }));
  }
}

function renderLayer(layer) {
  const t0 = performance.now();
  const cv = layer.canvas;
  cv.width = Math.ceil(layer.w * TEXELS);
  cv.height = Math.ceil(layer.h * TEXELS);
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.setTransform(TEXELS, 0, 0, TEXELS, -layer.x0 * TEXELS, -layer.y0 * TEXELS);
  play(c, layer.ops, layer.strings, layer.sheets, layer.font);
  layer.drawn = true;
  layer.renderMs = performance.now() - t0;
}

// Blits a static layer: world origin at (ox, oy) device pixels, s device pixels per texel. Only the visible part is copied.
function blit(layer, s, ox, oy) {
  if (!layer || !layer.drawn) return;
  const cv = layer.canvas;
  const dx0 = ox + Math.round(layer.x0 * TEXELS) * s, dy0 = oy + Math.round(layer.y0 * TEXELS) * s;
  const sx0 = Math.max(0, Math.floor(-dx0 / s)), sy0 = Math.max(0, Math.floor(-dy0 / s));
  const sx1 = Math.min(cv.width, Math.ceil((canvas.width - dx0) / s)), sy1 = Math.min(cv.height, Math.ceil((canvas.height - dy0) / s));
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.drawImage(cv, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0 + sx0 * s, dy0 + sy0 * s, (sx1 - sx0) * s, (sy1 - sy0) * s);
}

let view = [1, 0, 0];

// The frame: the house, then the frame's list over it with the camera's transform (its marks tint the house and draw the name plates).
function draw(f) {
  view = f.view;
  const [s, ox, oy] = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  blit(layers.get('house'), s, ox, oy);
  ctx.setTransform(s * TEXELS, 0, 0, s * TEXELS, ox, oy);
  play(ctx, f.list, f.strings, f.sheets, font);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// The ops of a frame: a Uint8Array from Blazor's byte-array interop, or base64 if it came as JSON.
function floats(ops) {
  if (typeof ops === 'string') {
    const bin = atob(ops), bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    ops = bytes;
  }
  return new Float32Array(ops.buffer.slice(ops.byteOffset, ops.byteOffset + ops.byteLength));
}

let font = '';
export function configureFont(family) { font = family; }

// One frame. An exception here (C# catches its own, Web 10/10; this is the interop or the drawing) is logged once and the loop goes on:
// the next frame is always asked for, so one bad frame never freezes the game (and its hourly autosave) for good.
let frameErrors = 0;
function tick(t) {
  try { frame(t); }
  catch (e) { if (frameErrors++ === 0) console.error('[ERROR] frame', e); }
  finally { if (raf) raf = requestAnimationFrame(tick); }
}

function frame(t) {
  const dt = last ? (t - last) / 1000 : 0;
  last = t;
  const t0 = performance.now();
  const f = dotnet.invokeMethod('Frame', dt);
  f.list = floats(f.ops);
  const t1 = performance.now();
  frameNo++;
  if (frameNo === 1) performance.mark('hearth-first-frame');   // the start-up's end, for measuring a cold start (Web 9/10)
  draw(f);
  mark(f.mark);
  if (frameNo % KEEP_FRAMES === 0) sweep();
  const t2 = performance.now();
  stats.frames++;
  stats.interopMs += t1 - t0;
  stats.drawMs += t2 - t1;
  stats.frameMs += t2 - t0;
  stats.maxMs = Math.max(stats.maxMs, t2 - t0);
}

// Frame cost so far (averages in ms) and the layers' render times; resets the counters.
export function frameStats() {
  const n = Math.max(1, stats.frames);
  const out = {
    frames: stats.frames, errors: frameErrors, images: images.size, texts: texts.size, frameMs: stats.frameMs / n, interopMs: stats.interopMs / n, drawMs: stats.drawMs / n, maxMs: stats.maxMs,
    layers: Object.fromEntries([...layers].map(([k, l]) => [k, { w: l.canvas.width, h: l.canvas.height, renderMs: l.renderMs }])),
  };
  Object.assign(stats, { frames: 0, frameMs: 0, interopMs: 0, drawMs: 0, maxMs: 0 });
  return out;
}

// ---- input ----

const pointers = new Map();
let pinchDist = 0, wheelAcc = 0;

function at(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function pair() {
  const [a, b] = [...pointers.values()];
  return { mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
}

function down(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, at(e));
  if (pointers.size === 1) dotnet.invokeMethod('PointerDown', ...at(e));
  else if (pointers.size === 2) {
    const p = pair();
    pinchDist = Math.max(1, p.d);
    dotnet.invokeMethod('PinchStart', p.mx, p.my);
  }
  e.preventDefault();
}

function move(e) {
  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && pointers.size === 0) dotnet.invokeMethod('Hover', ...at(e), true);
    return;
  }
  pointers.set(e.pointerId, at(e));
  if (pointers.size === 1) dotnet.invokeMethod('PointerMove', ...at(e), blocked(e));
  else if (pointers.size === 2) {
    const p = pair();
    dotnet.invokeMethod('PinchMove', p.d / pinchDist, p.mx, p.my);
  }
}

// Something of the page (the sidebar, a panel, the chatter, the bars) is over the canvas at the pointer: a worker dropped there is not
// ordered to the room under it, and the ghost shows that (Web 10/10, the Godot view's GuiGetHoveredControl). The canvas has the pointer
// captured, but elementFromPoint still sees what is on top.
function blocked(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el !== canvas;
}

function up(e) {
  if (!pointers.has(e.pointerId)) return;
  const was = pointers.size;
  pointers.delete(e.pointerId);
  // the capture is lost without a pointerup when the browser takes the pointer away: the gesture is cancelled, as pointercancel
  const cancel = e.type === 'pointercancel' || e.type === 'lostpointercapture';
  if (was === 1) dotnet.invokeMethod('PointerUp', ...at(e), cancel, !cancel && blocked(e));
  else if (was === 2) {
    // the other finger carries on as a drag (never a tap: C# knows a pinch happened)
    const [rest] = [...pointers.values()];
    dotnet.invokeMethod('PinchEnd', rest[0], rest[1]);
  }
}

// Keys for the game, unless the player is typing (the Talk field) or holds a modifier (the browser's own shortcuts).
function key(e) {
  if (!dotnet || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;   // a held key acts once, as Godot's Echo: false
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && e.key !== 'Escape') return;
  if (dotnet.invokeMethod('Key', e.key)) e.preventDefault();
}

// Puts a panel on its stage: beside the anchor (to the right, or to the left when there is no room) or at it, then inside the stage with
// a 2 px margin (as the Godot view keeps its menus on the screen). The panel was drawn hidden, so it does not show at the wrong place.
export function place(el, mode, ax, ay, reach, up) {
  if (!el || !el.offsetParent) return;
  const stage = el.offsetParent, W = stage.clientWidth, H = stage.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
  let x = ax, y = ay;
  if (mode === 'beside') {
    x = ax + reach;
    if (x + w > W - 2) x = ax - reach - w;
    y = ay - up;
  }
  x = Math.min(Math.max(2, x), Math.max(2, W - w - 2));
  y = Math.min(Math.max(2, y), Math.max(2, H - h - 2));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.style.visibility = 'visible';
}

// A small picture of its own (an info card's portrait: PaintList ops in w x h units) into a canvas of the page, k device pixels a unit.
// A sheet that is not loaded yet draws it again when it is.
export function portrait(el, ops, strings, sheets, w, h, k) {
  if (!el) return;
  const list = floats(ops);
  el.width = Math.round(w * k); el.height = Math.round(h * k);
  const c = el.getContext('2d');
  const paint = () => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.width, el.height);
    c.imageSmoothingEnabled = false;
    c.setTransform(k, 0, 0, k, 0, 0);
    play(c, list, strings, sheets, font);
  };
  paint();
  for (const n of sheets) {
    const s = sheet(n);
    if (!s.ready && !s.failed) s.waiters.push(paint);
  }
}

// An element's rectangle in CSS pixels of the window ([x, y, w, h]), or null when none matches or it is not shown.
export function rectOf(selector) {
  const el = document.querySelector(selector);
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
}

// The tutorial's frame and arrow (Hearth.View's TutorialMarker, computed in C#: WebGuide.Mark), over the page and its top bar but under
// the panels, the card and the menu, as the Godot view's tutorial layer; it never takes a tap.
let markSvg = null;
function mark(m) {
  if (!m) { if (markSvg) markSvg.style.display = 'none'; return; }
  if (!markSvg) {
    const ns = 'http://www.w3.org/2000/svg';
    markSvg = document.createElementNS(ns, 'svg');
    markSvg.setAttribute('class', 'hearth-mark');
    markSvg.append(document.createElementNS(ns, 'rect'), document.createElementNS(ns, 'polygon'));
    (canvas.closest('.hearth') || document.body).append(markSvg);
  }
  const [x, y, w, h, tx, ty, lx, ly, rx, ry, r, g, b, line] = m;
  const c = colour(r, g, b, 1);
  const [rect, tri] = markSvg.children;
  rect.setAttribute('x', x); rect.setAttribute('y', y); rect.setAttribute('width', w); rect.setAttribute('height', h);
  rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', c); rect.setAttribute('stroke-width', line);
  tri.setAttribute('points', `${tx},${ty} ${lx},${ly} ${rx},${ry}`);
  tri.setAttribute('fill', c);
  markSvg.style.display = '';
}

// Scrolls the first element that matches a selector to the top of its scrolling panel (the ledger opens at its stores so).
export function scrollTo(selector) {
  const el = document.querySelector(selector);
  if (el) el.scrollIntoView({ block: 'start' });
}

function leave(e) {
  if (e.pointerType === 'mouse') dotnet.invokeMethod('Hover', 0, 0, false);
}

function wheel(e) {
  e.preventDefault();
  wheelAcc += e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1);
  const step = e.ctrlKey ? 25 : 60;   // a trackpad pinch comes as small wheel steps with ctrl
  let steps = 0;
  while (wheelAcc <= -step) { steps++; wheelAcc += step; }
  while (wheelAcc >= step) { steps--; wheelAcc -= step; }
  if (steps !== 0) dotnet.invokeMethod('Wheel', steps, ...at(e));
}

let observer = null;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  // the game picks the size to draw at: the screen's, or upright a whole number of house widths that the browser scales down smoothly
  const [bw, bh] = dotnet.invokeMethod('Resize', w, h, dpr, window.innerWidth, window.innerHeight);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  canvas.style.imageRendering = bw === w ? '' : 'auto';
}

export function start(el, ref) {
  stop();
  canvas = el;
  ctx = canvas.getContext('2d', { alpha: false });
  dotnet = ref;
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('wheel', wheel, { passive: false });
  document.addEventListener('visibilitychange', hidden);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // Safari zooms the page on a pinch whatever the viewport says; the canvas pinches the house instead (Web 9/10)
  document.addEventListener('gesturestart', e => e.preventDefault());
  window.addEventListener('keydown', key);
  observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  last = 0;
  raf = requestAnimationFrame(tick);
}

export function stop() {
  if (raf) cancelAnimationFrame(raf);
  markSvg?.remove();
  markSvg = null;
  raf = 0;
  observer?.disconnect();
  observer = null;
  if (canvas) {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('lostpointercapture', up);
    canvas.removeEventListener('pointerleave', leave);
    canvas.removeEventListener('wheel', wheel);
  }
  window.removeEventListener('keydown', key);
  document.removeEventListener('visibilitychange', hidden);
  pointers.clear();
}

// The page was hidden in the middle of a gesture (a call, the home screen): the fingers' pointerup may never come, and a finger left in
// the map would make every later tap a pinch. The gesture is cancelled and forgotten.
function hidden() {
  if (document.visibilityState !== 'hidden' || pointers.size === 0) return;
  pointers.clear();
  dotnet?.invokeMethod('PointerUp', 0, 0, true, false);
}
