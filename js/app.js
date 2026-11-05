// app.js
// يربط الكاميرا وتتبّع اليد والرسم والتعرّف على الحرف.

import { Recognizer, TEMPLATE_FONTS, LETTERS, shapeFromStrokes } from './recognizer.js?v=8';
import { loadModel, renderStrokes, toInput, predict } from './cnn.js?v=8';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const PINCH_ON = 0.32;   // المسافة بين السبابة والإبهام نسبة لحجم اليد
const PINCH_OFF = 0.46;
const RECOGNIZE_AFTER = 900; // كم ملي ثانية ننتظر بعد آخر ضربة
const RECOGNIZE_AFTER_HAND = 1600;
const SHAKES_TO_WIPE = 4;  // كم هزّة للكف عشان تمسح
const SHAKE_WINDOW = 2500; // والهزّات لازم تكون خلال هالمدة (ملي ثانية)
const DWELL = 1000;     // كم ملي ثانية توقّف الدائرة فوق زر عشان ينضغط
const NIB = (35 * Math.PI) / 180; // زاوية القلم المسطّح

const $ = (s) => document.querySelector(s);
const video = $('#cam');
const ink = $('#ink');
const hud = $('#hud');
const ictx = ink.getContext('2d');
const hctx = hud.getContext('2d');
const css = getComputedStyle(document.documentElement);
const INK = css.getPropertyValue('--ink').trim();
const GLOW = css.getPropertyValue('--ink-glow').trim();

const MODEL_URL = 'models/model_ar.json?v=8'; // CNN متدرّب على خط يد حقيقي
let model = null;

const recognizer = new Recognizer();     // احتياط: قوالب الخطوط العربية لو النموذج ما تحمّل
const userRec = new Recognizer();        // كتابات المستخدم اللي صحّحها
let ready = false;

let W = 0, H = 0, DPR = 1;
let strokes = [];      // [[{x, y, w}]]
let current = null;
let timer = 0;
let freshLetter = false; // بعد ما ينقرأ الحرف، أول ضربة جديدة تمسح اللوحة
let word = '';
let lastResult = null;

// ---------- canvas ----------

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  for (const c of [ink, hud]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  ictx.setTransform(DPR, 0, 0, DPR, 0, 0);
  hctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  redrawInk();
}

function baseWidth() {
  return Math.max(8, Math.min(22, Math.min(W, H) * 0.02));
}

function styleInk() {
  ictx.strokeStyle = ictx.fillStyle = INK;
  ictx.lineCap = ictx.lineJoin = 'round';
  ictx.shadowColor = GLOW;
  ictx.shadowBlur = 14;
}

// يرسم آخر جزء من الضربة بانحناءة ناعمة
function drawSegment(st, i) {
  const p = st[i];
  if (i === 0) {
    ictx.beginPath();
    ictx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
    ictx.fill();
    return;
  }
  const a = st[i - 1];
  const b = i > 1 ? st[i - 2] : a;
  const m1 = { x: (b.x + a.x) / 2, y: (b.y + a.y) / 2 };
  const m2 = { x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 };
  ictx.lineWidth = (a.w + p.w) / 2;
  ictx.beginPath();
  ictx.moveTo(m1.x, m1.y);
  ictx.quadraticCurveTo(a.x, a.y, m2.x, m2.y);
  ictx.stroke();
}

function redrawInk() {
  ictx.clearRect(0, 0, W, H);
  styleInk();
  for (const st of strokes) st.forEach((_, i) => drawSegment(st, i));
}

function clearInk() {
  strokes = [];
  current = null;
  ictx.clearRect(0, 0, W, H);
}

// ---------- pen ----------

function penDown(x, y) {
  clearTimeout(timer);
  if (freshLetter) {
    clearInk();
    freshLetter = false;
    hideResult();
  }
  current = [{ x, y, w: baseWidth() * 0.95 }];
  strokes.push(current);
  styleInk();
  drawSegment(current, 0);
}

function penMove(x, y) {
  if (!current) return;
  const last = current[current.length - 1];
  const dist = Math.hypot(x - last.x, y - last.y);
  if (dist < 1.5) return;
  // القلم المسطّح: الخط يعرض لما الحركة تكون عمودية على زاوية القلم
  const theta = Math.atan2(y - last.y, x - last.x);
  const target = baseWidth() * (0.28 + 0.72 * Math.abs(Math.sin(theta - NIB)));
  const w = last.w * 0.65 + target * 0.35;
  current.push({ x, y, w, t: performance.now() });
  drawSegment(current, current.length - 1);
}

// trim: كم ملي ثانية نقص من آخر الضربة. لما تبعّد أصابعك، النقطة تنحرف شوي قبل ما يوقف الرسم
function penUp(trim = 0) {
  if (!current) return;
  if (trim && current.length > 4) {
    const end = current[current.length - 1].t;
    const kept = current.filter((p, i) => i < 2 || !p.t || p.t <= end - trim);
    if (kept.length < current.length) {
      current.splice(0, current.length, ...kept);
      redrawInk();
    }
  }
  current = null;
  clearTimeout(timer);
  // باليد تاخذ وقت أطول عشان تروح للنقاط، فننتظر أكثر
  timer = setTimeout(recognize, cameraOn ? RECOGNIZE_AFTER_HAND : RECOGNIZE_AFTER);
}

// يمسح اللي على اللوحة. ولو الحرف اللي عليها توه انقرأ، يشيله من الكلمة بعد
function wipe() {
  clearTimeout(timer);
  if (current) current = null;
  if (!strokes.length) return false;
  if (freshLetter && word) {
    word = word.slice(0, -1);
    renderWord();
  }
  freshLetter = false;
  clearInk();
  hideResult();
  toast('انمسح ✓');
  return true;
}

// ---------- recognition ----------

function letterName(char) {
  const e = LETTERS.find(([c]) => c === char);
  return e ? e[1] : char;
}

// يجمع رأي الشبكة مع كتابات المستخدم المحفوظة، ويرجّع أفضل 3
function classify(strs) {
  if (!model) return recognizer.recognize(strs);
  const input = toInput(renderStrokes(strs), model.size, model.fit);
  if (!input) return null;
  const probs = predict(model, input);
  const scores = new Map(model.labels.map((c, i) => [c, probs[i]]));

  // لو المستخدم علّمنا شكل حرف يشبه هذي الكتابة كثير، نعطيه وزن
  const only = new Set(model.labels);
  const d = userRec.distances(shapeFromStrokes(strs), only);
  if (d.size) {
    const dmin = Math.min(...d.values());
    const u = dmin < 2 ? 0.6 : dmin < 3.5 ? 0.3 : 0;
    if (u) {
      let sum = 0;
      const us = new Map();
      for (const [c, dist] of d) { const v = Math.exp(-(dist - dmin) / 1.2); us.set(c, v); sum += v; }
      for (const c of model.labels) scores.set(c, (1 - u) * scores.get(c) + u * ((us.get(c) || 0) / sum));
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([char, confidence]) => ({ char, name: letterName(char), confidence }));
}

function recognize() {
  if (!ready || !strokes.length) return;
  const top = classify(strokes);
  if (!top) {
    toast('الحرف صغير مرة، اكتبه أكبر شوي');
    clearInk();
    return;
  }
  lastResult = top;
  lastStrokes = strokes.map((st) => st.map((p) => ({ x: p.x, y: p.y })));
  word += top[0].char;
  renderWord();
  showResult(top);
  freshLetter = true;
}

function showResult(top) {
  $('#glyph').textContent = top[0].char;
  const alts = $('#alts');
  alts.innerHTML = '';
  if (top.length > 1) {
    const label = document.createElement('div');
    label.className = 'alts-label';
    label.textContent = 'مو هذا؟';
    alts.append(label);
  }
  for (const r of top.slice(1)) {
    const b = document.createElement('button');
    b.textContent = r.char;
    b.addEventListener('click', () => replaceLast(r));
    alts.append(b);
  }
  const more = document.createElement('button');
  more.textContent = 'غيره…';
  more.addEventListener('click', togglePicker);
  alts.append(more);
  $('#picker').hidden = true;
  const box = $('#result');
  box.classList.remove('show');
  void box.offsetWidth; // يعيد تشغيل الحركة
  box.classList.add('show');
}

function hideResult() {
  $('#result').classList.remove('show');
  $('#picker').hidden = true;
}

// كل الحروف، لما الحرف الصح مو من ضمن الاقتراحات
function togglePicker() {
  const picker = $('#picker');
  if (!picker.childElementCount) {
    for (const [char, name] of LETTERS) {
      const b = document.createElement('button');
      b.textContent = char;
      b.title = name;
      b.addEventListener('click', () => {
        replaceLast({ char, name, confidence: 1 });
        picker.hidden = true;
      });
      picker.append(b);
    }
  }
  picker.hidden = !picker.hidden;
}

function replaceLast(r) {
  if (!word) return;
  word = word.slice(0, -1) + r.char;
  renderWord();
  const others = lastResult.filter((x) => x.char !== r.char);
  showResult([r, ...others]);
  learn(r.char, lastStrokes);
}

// ---------- learning from corrections ----------

const SAMPLES_KEY = 'harf.samples.v1';
let lastStrokes = [];

function loadSamples() {
  try {
    return JSON.parse(localStorage.getItem(SAMPLES_KEY)) || [];
  } catch {
    return [];
  }
}

function learn(char, strs) {
  if (!strs.length || !userRec.addSample(char, strs)) return;
  // نحفظ النقاط بأرقام صحيحة عشان يصغر حجمها
  const compact = strs.map((st) => st.map((p) => [Math.round(p.x), Math.round(p.y)]));
  const all = loadSamples();
  all.push({ char, strokes: compact });
  try {
    localStorage.setItem(SAMPLES_KEY, JSON.stringify(all.slice(-200)));
  } catch { /* التخزين مقفل */ }
  toast(`تعلّمت شكل «${char}» حقّك ✓`);
}

function restoreSamples() {
  for (const s of loadSamples()) {
    if (!LETTERS.some(([c]) => c === s.char)) continue; // عيّنات قديمة من الوضع الإنجليزي
    userRec.addSample(s.char, s.strokes.map((st) => st.map(([x, y]) => ({ x, y }))));
  }
}

function renderWord() {
  const el = $('#word');
  if (!word.trim()) {
    el.innerHTML = '<span class="placeholder">الحروف اللي تكتبها تتجمّع هنا</span>';
  } else {
    el.textContent = word;
  }
  el.scrollLeft = -el.scrollWidth;
}

// ---------- mouse & touch ----------

function toLocal(e) {
  const r = ink.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

ink.addEventListener('pointerdown', (e) => {
  try { ink.setPointerCapture(e.pointerId); } catch { /* مؤشر وهمي */ }
  const p = toLocal(e);
  penDown(p.x, p.y);
});
ink.addEventListener('pointermove', (e) => {
  if (!current || pinching) return;
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of coalesced.length ? coalesced : [e]) {
    const p = toLocal(ev);
    penMove(p.x, p.y);
  }
});
ink.addEventListener('pointerup', () => penUp());
ink.addEventListener('pointercancel', () => penUp());

// ---------- camera & hand tracking ----------

class OneEuro {
  constructor(minCutoff = 0.7, beta = 0.007, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.t = null; }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.t === null) {
      Object.assign(this, { t, x, dx: 0 });
      return x;
    }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

let landmarker = null;
let cameraOn = false;
let pinching = false;
let pinchFrames = 0;
let lostAt = 0;
let lastVideoTime = -1;
let palmFired = false;
let palmSeen = 0;
const shake = { times: [], dir: 0, ext: null };
let dwellEl = null;
let dwellStart = 0;
let dwellDone = false;
const fx = new OneEuro();
const fy = new OneEuro();

async function startCamera() {
  const btn = $('#btn-camera');
  btn.disabled = true;
  btn.textContent = 'جاري التحميل…';
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch {
      landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    cameraOn = true;
    document.body.classList.add('camera-on');
    closeIntro();
    requestAnimationFrame(trackLoop);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'ابدأ';
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(denied ? 'ما انسمح للكاميرا. تقدر تجرّب بالماوس.' : 'ما قدرت أشغّل الكاميرا. تقدر تجرّب بالماوس.');
  }
}

// يحوّل نقطة من الفيديو لمكانها على الشاشة (الفيديو معروض بـ cover ومعكوس)
function toScreen(lm) {
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  return { x: W - (lm.x * vw * s + ox), y: lm.y * vh * s + oy };
}

function trackLoop(now) {
  if (!cameraOn) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    handleHand(res.landmarks && res.landmarks[0], now);
  }
  requestAnimationFrame(trackLoop);
}

function handleHand(lm, now) {
  hctx.clearRect(0, 0, W, H);
  if (!lm) {
    // اليد اختفت: نعطيها لحظة قبل ما نوقف الضربة
    if (!lostAt) lostAt = now;
    if (pinching && now - lostAt > 200) {
      pinching = false;
      penUp(90);
    }
    fx.reset();
    fy.reset();
    return;
  }
  lostAt = 0;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const size = d(lm[0], lm[9]) || 1;
  const ratio = d(lm[4], lm[8]) / size;

  const raw = toScreen({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 });
  const p = { x: fx.filter(raw.x, now), y: fy.filter(raw.y, now) };

  // ✋ الكف المفتوح يوقف الكتابة فوراً، وهزّه 4 مرات أو أكثر يمسح
  const palm = isOpenPalm(lm, ratio);
  if (palm && pinching) {
    pinching = false;
    pinchFrames = 0;
    penUp(90);
  }
  let palmProgress = 0;
  if (palm) {
    palmSeen = now;
    const count = countShakes(lm[9].x, size, now);
    palmProgress = palmFired ? 0 : Math.min(1, count / SHAKES_TO_WIPE);
    if (count >= SHAKES_TO_WIPE && !palmFired) {
      palmFired = true;
      wipe();
    }
  } else if (now - palmSeen > 300) {
    // الكف ممكن تضيع فريم أو فريمين وهي تهتز، فما نصفّر العد على طول
    resetShake();
  }

  // ⏳ الدائرة واقفة فوق زر = ضغطة
  let dwellProgress = 0;
  const target = !pinching && !palm ? buttonAt(p) : null;
  if (target !== dwellEl) {
    if (dwellEl) dwellEl.classList.remove('hand-hover');
    dwellEl = target;
    dwellStart = now;
    dwellDone = false;
    if (dwellEl) dwellEl.classList.add('hand-hover');
  }
  if (dwellEl && !dwellDone) {
    dwellProgress = Math.min(1, (now - dwellStart) / DWELL);
    if (dwellProgress >= 1) {
      dwellDone = true;
      dwellEl.click();
    }
  }

  if (!pinching && ratio < PINCH_ON && !dwellEl) {
    if (++pinchFrames >= 2) {
      pinching = true;
      penDown(p.x, p.y);
    }
  } else if (pinching && ratio > PINCH_OFF) {
    pinching = false;
    pinchFrames = 0;
    penUp(90);
  } else if (!pinching) {
    pinchFrames = 0;
  }
  if (pinching) penMove(p.x, p.y);

  drawHud(lm, p, ratio, { palmProgress, dwellProgress });
}

// يعد كم مرة غيّرت الكف اتجاهها يمين ويسار خلال SHAKE_WINDOW
function countShakes(x, size, now) {
  const need = size * 0.3; // الحركة الصغيرة ما تنحسب هزّة
  if (shake.ext === null) shake.ext = x;
  if (shake.dir === 0) {
    if (Math.abs(x - shake.ext) > need) {
      shake.dir = Math.sign(x - shake.ext);
      shake.ext = x;
    }
  } else if ((x - shake.ext) * shake.dir > 0) {
    shake.ext = x;
  } else if ((shake.ext - x) * shake.dir > need) {
    shake.dir = -shake.dir;
    shake.ext = x;
    shake.times.push(now);
  }
  shake.times = shake.times.filter((t) => now - t < SHAKE_WINDOW);
  return shake.times.length;
}

function resetShake() {
  shake.times = [];
  shake.dir = 0;
  shake.ext = null;
  palmFired = false;
}

// الأصابع الأربعة ممدودة (أطرافها أبعد عن الرسغ من مفاصلها) والإبهام مو ماسك السبابة
function isOpenPalm(lm, ratio) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = lm[0];
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    if (d(lm[tip], w) < d(lm[pip], w) * 1.12) return false;
  }
  return ratio > PINCH_OFF;
}

function buttonAt(p) {
  const el = document.elementFromPoint(p.x, p.y);
  const btn = el && el.closest('button');
  return btn && !btn.disabled && btn.offsetParent ? btn : null;
}

function drawHud(lm, p, ratio, { palmProgress = 0, dwellProgress = 0 } = {}) {
  // نقاط اليد خفيفة عشان تعرف وين يدك
  hctx.fillStyle = 'rgba(243, 239, 230, 0.35)';
  for (const i of [0, 4, 5, 8, 9, 12, 13, 16, 17, 20]) {
    const s = toScreen(lm[i]);
    hctx.beginPath();
    hctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    hctx.fill();
  }
  // المؤشر: دائرة تصغر كل ما قرّبت أصابعك، وتنعبّي لما تبدأ الرسم
  const r = pinching ? 9 : 10 + Math.min(1, Math.max(0, (ratio - PINCH_ON) / 0.5)) * 18;
  hctx.lineWidth = 2;
  hctx.strokeStyle = pinching ? INK : 'rgba(243, 239, 230, 0.8)';
  hctx.beginPath();
  hctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  hctx.stroke();
  if (pinching) {
    hctx.fillStyle = INK;
    hctx.beginPath();
    hctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    hctx.fill();
  }
  // حلقة تتعبّى وأنت فاتح كفّك أو واقف فوق زر
  const arc = (x, y, rad, prog, color) => {
    hctx.lineWidth = 4;
    hctx.strokeStyle = color;
    hctx.beginPath();
    hctx.arc(x, y, rad, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
    hctx.stroke();
  };
  if (dwellProgress > 0) arc(p.x, p.y, r + 8, dwellProgress, INK);
  if (palmProgress > 0) {
    const c = toScreen(lm[9]);
    arc(c.x, c.y, 60, palmProgress, 'rgba(244, 162, 97, 0.9)');
    hctx.font = '600 15px "IBM Plex Sans Arabic"';
    hctx.fillStyle = 'rgba(244, 162, 97, 0.95)';
    hctx.textAlign = 'center';
    hctx.fillText('هزّ', c.x, c.y + 5);
  }
}

// ---------- ui ----------

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function closeIntro() {
  $('#intro').classList.add('hidden');
}

function saveImage() {
  const text = word.trim();
  if (!text) {
    toast('اكتب حرف واحد على الأقل');
    return;
  }
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 900;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(1100, 120, 50, 800, 450, 1000);
  g.addColorStop(0, '#1b2440');
  g.addColorStop(1, '#0d1220');
  x.fillStyle = g;
  x.fillRect(0, 0, c.width, c.height);
  x.direction = 'rtl';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  let size = 320;
  x.font = `700 ${size}px "Aref Ruqaa", serif`;
  while (x.measureText(text).width > 1400 && size > 80) {
    size -= 10;
    x.font = `700 ${size}px "Aref Ruqaa", serif`;
  }
  x.shadowColor = GLOW;
  x.shadowBlur = 40;
  x.fillStyle = INK;
  x.fillText(text, 800, 420);
  x.shadowBlur = 0;
  x.font = '500 30px "IBM Plex Sans Arabic"';
  x.fillStyle = 'rgba(243, 239, 230, 0.55)';
  x.fillText('كُتبت في الهوا ✍️ حرف في الهوا', 800, 800);
  const a = document.createElement('a');
  a.download = `harf-${Date.now()}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

$('#btn-camera').addEventListener('click', startCamera);
$('#btn-mouse').addEventListener('click', () => {
  closeIntro();
  toast('اضغط واسحب عشان تكتب');
});
$('#btn-help').addEventListener('click', () => $('#intro').classList.remove('hidden'));
$('#btn-space').addEventListener('click', () => { word += ' '; renderWord(); });
// زر واحد للحذف: يمسح اللي على اللوحة، ولو كانت فاضية يحذف آخر حرف
$('#btn-back').addEventListener('click', () => {
  if (wipe()) return;
  word = word.slice(0, -1);
  renderWord();
  hideResult();
});
$('#btn-save').addEventListener('click', saveImage);

window.addEventListener('keydown', (e) => {
  if (e.target.closest('button')) return;
  if (e.key === 'Backspace') $('#btn-back').click();
  else if (e.key === ' ') { e.preventDefault(); $('#btn-space').click(); }
  else if (e.key === 'Escape') { word = ''; renderWord(); clearInk(); hideResult(); }
});
window.addEventListener('resize', resize);
resize();

// نجهّز النموذج، وقوالب الخطوط الاحتياطية بعد ما تتحمّل الخطوط
Promise.all([
  loadModel(MODEL_URL).then((m) => { model = m; }).catch((err) => {
    console.error(err);
    toast('ما تحمّل النموذج، بستخدم الطريقة الاحتياطية');
  }),
  Promise.all(TEMPLATE_FONTS.map((f) => document.fonts.load(`150px "${f}"`, 'ابت'))).catch(() => {}),
]).then(() => {
  recognizer.build();
  restoreSamples();
  ready = true;
  if (strokes.length && !current) recognize();
  window.__harf = {
    recognizer, userRec, get model() { return model; }, handleHand, classify,
    get strokes() { return strokes; }, get word() { return word; },
  };
});
