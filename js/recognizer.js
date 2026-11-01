// recognizer.js
// يتعرّف على حرف عربي مكتوب بخط اليد بدون أي تدريب:
// يرسم كل حرف من خطّين (نسخ ورقعة)، ويحوّل الحرف والكتابة لهيكل بعرض بكسل واحد،
// وبعدين يقارنهم بمسافة الـ chamfer. أقرب حرف يفوز.

export const LETTERS = [
  ['ا', 'ألف'], ['ب', 'باء'], ['ت', 'تاء'], ['ث', 'ثاء'], ['ج', 'جيم'], ['ح', 'حاء'], ['خ', 'خاء'],
  ['د', 'دال'], ['ذ', 'ذال'], ['ر', 'راء'], ['ز', 'زاي'], ['س', 'سين'], ['ش', 'شين'], ['ص', 'صاد'],
  ['ض', 'ضاد'], ['ط', 'طاء'], ['ظ', 'ظاء'], ['ع', 'عين'], ['غ', 'غين'], ['ف', 'فاء'], ['ق', 'قاف'],
  ['ك', 'كاف'], ['ل', 'لام'], ['م', 'ميم'], ['ن', 'نون'], ['ه', 'هاء'], ['و', 'واو'], ['ي', 'ياء'],
];

export const TEMPLATE_FONTS = ['Noto Naskh Arabic', 'Aref Ruqaa', 'Amiri', 'Lateef', 'Cairo'];

const G = 48;      // حجم الشبكة اللي نقارن عليها
const PAD = 4;
const SRC = 260;   // حجم الكانفس اللي نرسم عليه قبل التصغير

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// من كانفس فيه شكل (أي لون، على خلفية شفافة) إلى { pts, dt } على شبكة G×G
function shapeFromCanvas(src) {
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const { data } = sctx.getImageData(0, 0, src.width, src.height);
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (data[(y * src.width + x) * 4 + 3] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (Math.max(bw, bh) < 8) return null;

  const g = makeCanvas(G, G);
  const gctx = g.getContext('2d', { willReadFrequently: true });
  const s = (G - 2 * PAD) / Math.max(bw, bh);
  const dw = bw * s, dh = bh * s;
  gctx.imageSmoothingEnabled = true;
  gctx.drawImage(src, x0, y0, bw, bh, (G - dw) / 2, (G - dh) / 2, dw, dh);
  const gd = gctx.getImageData(0, 0, G, G).data;

  const mask = new Uint8Array(G * G);
  for (let i = 0; i < G * G; i++) mask[i] = gd[i * 4 + 3] > 90 ? 1 : 0;
  // عدد الأجزاء المنفصلة = جسم الحرف + نقاطه، وهو اللي يفرّق ر عن ز و س عن ش
  const parts = countParts(mask, G, G);
  thin(mask, G, G);

  const pts = [];
  for (let i = 0; i < G * G; i++) if (mask[i]) pts.push(i);
  if (pts.length < 3) return null;
  return { pts, dt: distanceTransform(mask, G, G), mask, parts, aspect: bw / bh };
}

// يعد الأجزاء المتصلة (8 اتجاهات)، ويتجاهل الفتات الصغير
function countParts(m, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    let size = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % w, y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (m[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
    }
    if (size >= 3) n++;
  }
  return Math.min(n, 4);
}

// Zhang-Suen thinning: يخلي الخط بعرض بكسل واحد
function thin(m, w, h) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                    (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
          del.push(i);
        }
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
}

// مسافة كل بكسل عن أقرب نقطة في الشكل (chamfer 1 / √2)
function distanceTransform(m, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 0 : 1e6;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

export const WEIGHTS = { parts: 1.5, aspect: 0.6 };

function distance(a, b) {
  let s = 0;
  for (const p of a.pts) s += b.dt[p];
  let t = 0;
  for (const p of b.pts) t += a.dt[p];
  return s / a.pts.length + t / b.pts.length +
    WEIGHTS.parts * Math.abs(a.parts - b.parts) +
    WEIGHTS.aspect * Math.abs(Math.log(a.aspect / b.aspect));
}

// يرسم حرف بخط معيّن ويرجّع شكله
export function shapeFromGlyph(char, font) {
  const c = makeCanvas(SRC, SRC);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = `150px "${font}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(char, SRC / 2, SRC / 2);
  return shapeFromCanvas(c);
}

// strokes = [[{x, y}, ...], ...] بإحداثيات الشاشة
export function shapeFromStrokes(strokes) {
  const all = strokes.flat();
  if (!all.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of all) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const s = 170 / span;
  const ox = (SRC - (x1 - x0) * s) / 2, oy = (SRC - (y1 - y0) * s) / 2;
  const c = makeCanvas(SRC, SRC);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.strokeStyle = ctx.fillStyle = '#000';
  ctx.lineWidth = 14;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const st of strokes) {
    const pts = st.map((p) => ({ x: ox + (p.x - x0) * s, y: oy + (p.y - y0) * s }));
    // نقطة الحرف تكون غالباً ضربة قصيرة جداً، نرسمها دائرة
    const len = pts.reduce((L, p, i) => (i ? L + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
    if (len < 12) {
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  return shapeFromCanvas(c);
}

export class Recognizer {
  constructor() {
    this.templates = [];
  }

  // لازم الخطوط تكون محمّلة قبل، وإلا ينرسم الحرف بخط النظام
  build(fonts = TEMPLATE_FONTS) {
    this.templates = [];
    for (const font of fonts) {
      for (const [char, name] of LETTERS) {
        const shape = shapeFromGlyph(char, font);
        if (shape) this.templates.push({ char, name, font, shape });
      }
    }
    return this.templates.length;
  }

  // يتعلّم من خط المستخدم: لما يصحّح حرف، نضيف كتابته كقالب جديد لهذا الحرف (عربي أو إنجليزي)
  addSample(char, strokes) {
    const entry = LETTERS.find(([c]) => c === char);
    const shape = shapeFromStrokes(strokes);
    if (!shape) return false;
    this.templates.push({ char, name: entry ? entry[1] : char, font: 'user', shape });
    return true;
  }

  // أقرب مسافة لكل حرف: Map(char -> d)
  distances(shape, only = null) {
    const best = new Map();
    if (!shape) return best;
    for (const t of this.templates) {
      if (only && !only.has(t.char)) continue;
      const d = distance(shape, t.shape);
      if (!best.has(t.char) || d < best.get(t.char)) best.set(t.char, d);
    }
    return best;
  }

  recognizeShape(shape, k = 3) {
    if (!shape || !this.templates.length) return null;
    const best = new Map();
    for (const t of this.templates) {
      const d = distance(shape, t.shape);
      if (!best.has(t.char) || d < best.get(t.char).d) best.set(t.char, { char: t.char, name: t.name, d });
    }
    const ranked = [...best.values()].sort((a, b) => a.d - b.d);
    const top = ranked.slice(0, 5);
    const w = top.map((r) => Math.exp(-(r.d - top[0].d) / 1.2));
    const sum = w.reduce((a, b) => a + b, 0);
    return top.slice(0, k).map((r, i) => ({ ...r, confidence: w[i] / sum }));
  }

  recognize(strokes, k = 3) {
    return this.recognizeShape(shapeFromStrokes(strokes), k);
  }
}
