// cnn.js
// يشغّل شبكة CNN صغيرة داخل المتصفح بدون أي مكتبة.
// الشبكة متدرّبة على خط يد حقيقي (AHCD للعربي، EMNIST للإنجليزي) في tools/train.py،
// والتجهيز هنا (قص، توسيط، تنحيف، تسميك) لازم يطابق اللي في التدريب بالضبط.

const SRC = 260;

function decode(layer) {
  const bin = atob(layer.data);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    out[i] = (b > 127 ? b - 256 : b) * layer.scale;
  }
  return out;
}

export async function loadModel(url) {
  const json = await (await fetch(url)).json();
  const w = {};
  for (const [name, layer] of Object.entries(json.layers)) w[name] = decode(layer);
  return { labels: json.labels, size: json.size, fit: json.fit, meta: json.meta, w };
}

// ---------- preprocessing ----------

// strokes = [[{x, y}]] -> كانفس SRC×SRC فيه الكتابة بخط ثابت
export function renderStrokes(strokes) {
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
  const c = document.createElement('canvas');
  c.width = c.height = SRC;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.strokeStyle = ctx.fillStyle = '#fff';
  ctx.lineWidth = 14;
  ctx.lineCap = ctx.lineJoin = 'round';
  const dots = [];
  for (const st of strokes) {
    const pts = st.map((p) => ({ x: ox + (p.x - x0) * s, y: oy + (p.y - y0) * s }));
    const len = pts.reduce((L, p, i) => (i ? L + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
    if (len < 12) {
      // نقطة الحرف، نرسمها بعدين
      dots.push({
        x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
        y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
      });
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  drawDots(ctx, dots);
  return c;
}

// أغلب الناس يكتبون النقطتين (ت، ق، ي) شرطة وحدة، وهذا اللي تعلّمته الشبكة،
// فأي نقطتين جنب بعض بنفس المستوى نرسمهم شرطة. ثلاث نقاط تبقى زي ما هي.
function drawDots(ctx, dots) {
  const near = (a, b) => Math.abs(a.y - b.y) < 22 && Math.abs(a.x - b.x) < 70;
  const used = new Set();
  if (dots.length === 2 && near(dots[0], dots[1])) {
    ctx.beginPath();
    ctx.moveTo(dots[0].x, dots[0].y);
    ctx.lineTo(dots[1].x, dots[1].y);
    ctx.stroke();
    used.add(0).add(1);
  }
  dots.forEach((d, i) => {
    if (used.has(i)) return;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 9, 0, Math.PI * 2);
    ctx.fill();
  });
}

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

// كانفس -> Float32Array بحجم size×size (0 أو 1)، نفس normalize() في التدريب
export function toInput(src, size = 32, fit = 22) {
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const { data } = sctx.getImageData(0, 0, src.width, src.height);
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (data[(y * src.width + x) * 4 + 3] > 0.35 * 255) {
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
  const s = fit / Math.max(bw, bh);
  const nw = Math.max(1, Math.round(bw * s)), nh = Math.max(1, Math.round(bh * s));
  const g = document.createElement('canvas');
  g.width = g.height = size;
  const gctx = g.getContext('2d', { willReadFrequently: true });
  gctx.imageSmoothingEnabled = true;
  gctx.imageSmoothingQuality = 'high';
  gctx.drawImage(src, x0, y0, bw, bh, Math.floor((size - nw) / 2), Math.floor((size - nh) / 2), nw, nh);
  const gd = gctx.getImageData(0, 0, size, size).data;
  const m = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) m[i] = gd[i * 4 + 3] > 0.3 * 255 ? 1 : 0;
  thin(m, size, size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (m[i] || (y > 0 && m[i - size]) || (y < size - 1 && m[i + size]) ||
          (x > 0 && m[i - 1]) || (x < size - 1 && m[i + 1])) out[i] = 1;
    }
  }
  return out;
}

// ---------- forward pass ----------

function conv3(input, C, H, W, weight, bias, O) {
  const out = new Float32Array(O * H * W);
  for (let o = 0; o < O; o++) {
    const ob = o * H * W;
    out.fill(bias[o], ob, ob + H * W);
    for (let c = 0; c < C; c++) {
      const ib = c * H * W;
      const wb = (o * C + c) * 9;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const k = weight[wb + ky * 3 + kx];
          if (k === 0) continue;
          const dy = ky - 1, dx = kx - 1;
          const ys = Math.max(0, -dy), ye = Math.min(H, H - dy);
          const xs = Math.max(0, -dx), xe = Math.min(W, W - dx);
          for (let y = ys; y < ye; y++) {
            const orow = ob + y * W, irow = ib + (y + dy) * W + dx;
            for (let x = xs; x < xe; x++) out[orow + x] += k * input[irow + x];
          }
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return out;
}

function pool2(input, C, H, W) {
  const h = H >> 1, w = W >> 1;
  const out = new Float32Array(C * h * w);
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = c * H * W + 2 * y * W + 2 * x;
        out[c * h * w + y * w + x] = Math.max(input[i], input[i + 1], input[i + W], input[i + W + 1]);
      }
    }
  }
  return out;
}

function dense(input, weight, bias, relu) {
  const O = bias.length, I = input.length;
  const out = new Float32Array(O);
  for (let o = 0; o < O; o++) {
    let s = bias[o];
    const b = o * I;
    for (let i = 0; i < I; i++) s += weight[b + i] * input[i];
    out[o] = relu && s < 0 ? 0 : s;
  }
  return out;
}

export function predict(model, input) {
  const { w } = model;
  const S = model.size;
  let x = conv3(input, 1, S, S, w['c1.weight'], w['c1.bias'], 32);
  x = pool2(conv3(x, 32, S, S, w['c2.weight'], w['c2.bias'], 32), 32, S, S);
  x = conv3(x, 32, S / 2, S / 2, w['c3.weight'], w['c3.bias'], 64);
  x = pool2(conv3(x, 64, S / 2, S / 2, w['c4.weight'], w['c4.bias'], 64), 64, S / 2, S / 2);
  x = pool2(conv3(x, 64, S / 4, S / 4, w['c5.weight'], w['c5.bias'], 128), 128, S / 4, S / 4);
  x = dense(x, w['f1.weight'], w['f1.bias'], true);
  const logits = dense(x, w['f2.weight'], w['f2.bias'], false);
  const max = Math.max(...logits);
  const e = logits.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return Array.from(e, (v) => v / sum);
}
