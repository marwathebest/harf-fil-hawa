// app.js
// يربط الكاميرا وتتبّع اليد والرسم والتعرّف على الحرف.

import { Recognizer, TEMPLATE_FONTS, LETTERS } from './recognizer.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const PINCH_ON = 0.32;   // المسافة بين السبابة والإبهام نسبة لحجم اليد
const PINCH_OFF = 0.46;
const RECOGNIZE_AFTER = 900; // كم ملي ثانية ننتظر بعد آخر ضربة
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

const recognizer = new Recognizer();
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
  setStatus('drawing');
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
  current.push({ x, y, w });
  drawSegment(current, current.length - 1);
}

function penUp() {
  if (!current) return;
  current = null;
  setStatus(cameraOn ? 'live' : 'idle');
  clearTimeout(timer);
  timer = setTimeout(recognize, RECOGNIZE_AFTER);
}

// ---------- recognition ----------

function recognize() {
  if (!ready || !strokes.length) return;
  const top = recognizer.recognize(strokes);
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
  $('#glyph-name').textContent = `${top[0].name} · ${Math.round(top[0].confidence * 100)}%`;
  const alts = $('#alts');
  alts.innerHTML = '';
  if (top.length > 1) {
    const label = document.createElement('div');
    label.className = 'alts-label';
    label.textContent = 'قصدك حرف ثاني؟';
    alts.append(label);
  }
  for (const r of top.slice(1)) {
    const b = document.createElement('button');
    b.innerHTML = `${r.char}<span>${Math.round(r.confidence * 100)}%</span>`;
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
  if (!strs.length || !recognizer.addSample(char, strs)) return;
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
    recognizer.addSample(s.char, s.strokes.map((st) => st.map(([x, y]) => ({ x, y }))));
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
ink.addEventListener('pointerup', penUp);
ink.addEventListener('pointercancel', penUp);

// ---------- camera & hand tracking ----------

class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.008, dCutoff = 1.0) {
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
    setStatus('live');
    closeIntro();
    requestAnimationFrame(trackLoop);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'شغّل الكاميرا';
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(denied ? 'ما انسمح للكاميرا. تقدر تجرّب بالماوس.' : 'ما قدرت أشغّل الكاميرا. تقدر تجرّب بالماوس.');
  }
}

// يحوّل نقطة من الفيديو لمكانها على الشاشة (الفيديو معروض بـ cover ومعكوس)
function toScreen(lm) {
  const vw = video.videoWidth, vh = video.videoHeight;
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
      penUp();
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

  if (!pinching && ratio < PINCH_ON) {
    if (++pinchFrames >= 2) {
      pinching = true;
      penDown(p.x, p.y);
    }
  } else if (pinching && ratio > PINCH_OFF) {
    pinching = false;
    pinchFrames = 0;
    penUp();
  } else if (!pinching) {
    pinchFrames = 0;
  }
  if (pinching) penMove(p.x, p.y);

  drawHud(lm, p, ratio);
}

function drawHud(lm, p, ratio) {
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
}

// ---------- ui ----------

function setStatus(mode) {
  const el = $('#status');
  el.className = 'pill';
  if (mode === 'drawing') {
    el.classList.add('drawing');
    el.textContent = 'يرسم…';
  } else if (mode === 'live') {
    el.classList.add('live');
    el.textContent = 'الكاميرا شغّالة';
  } else {
    el.textContent = cameraOn ? 'الكاميرا شغّالة' : 'وضع الماوس';
  }
}

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
  x.font = `700 ${size}px "Aref Ruqaa"`;
  while (x.measureText(text).width > 1400 && size > 80) {
    size -= 10;
    x.font = `700 ${size}px "Aref Ruqaa"`;
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
  setStatus('idle');
  toast('اضغط واسحب عشان تكتب');
});
$('#btn-help').addEventListener('click', () => $('#intro').classList.remove('hidden'));
$('#btn-space').addEventListener('click', () => { word += ' '; renderWord(); });
$('#btn-back').addEventListener('click', () => { word = word.slice(0, -1); renderWord(); hideResult(); });
$('#btn-clear').addEventListener('click', () => { word = ''; renderWord(); clearInk(); hideResult(); });
$('#btn-save').addEventListener('click', saveImage);

window.addEventListener('keydown', (e) => {
  if (e.target.closest('button')) return;
  if (e.key === 'Backspace') $('#btn-back').click();
  else if (e.key === ' ') { e.preventDefault(); $('#btn-space').click(); }
  else if (e.key === 'Escape') $('#btn-clear').click();
});
window.addEventListener('resize', resize);
resize();

// نجهّز قوالب الحروف بعد ما تتحمّل الخطوط
Promise.all(TEMPLATE_FONTS.map((f) => document.fonts.load(`150px "${f}"`, 'ابت')))
  .catch(() => {})
  .then(() => {
    recognizer.build();
    restoreSamples();
    ready = true;
    if (strokes.length && !current) recognize();
    window.__harf = { recognizer, get strokes() { return strokes; }, get word() { return word; } };
  });
