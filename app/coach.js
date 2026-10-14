const api = window.coach; // from preload.js. Never name a constant here "coach": that would stop the whole script.
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const ink = $('ink'), card = $('card'), penEl = $('pen'), input = $('in');

/* ---------- a hand that is not perfect: every line gets a small wobble ---------- */
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const jit = (a) => (rnd() * 2 - 1) * a;
const f1 = (n) => n.toFixed(1);

function smooth(p) { // a soft curve through the points
  let d = `M${f1(p[0][0])},${f1(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[Math.max(i - 1, 0)], b = p[i], c = p[i + 1], e = p[Math.min(i + 2, p.length - 1)];
    d += ` C${f1(b[0] + (c[0] - a[0]) / 6)},${f1(b[1] + (c[1] - a[1]) / 6)} ${f1(c[0] - (e[0] - b[0]) / 6)},${f1(c[1] - (e[1] - b[1]) / 6)} ${f1(c[0])},${f1(c[1])}`;
  }
  return d;
}
function ringPath(cx, cy, rx, ry) { // a pen circle: it starts top left and runs past its own start
  const n = 18, a0 = -2.35 + jit(.25), over = .55 + rnd() * .2, p = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = a0 + t * (Math.PI * 2 + over), k = 1 + jit(.03) + (t - .5) * .07;
    p.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smooth(p);
}
function curve(x1, y1, x2, y2, bend = .02) { // a line with a small bow
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  const n = Math.max(3, Math.round(len / 70)), p = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, off = Math.sin(t * Math.PI) * len * bend + (i && i < n ? jit(1.3) : 0);
    p.push([x1 + dx * t + nx * off, y1 + dy * t + ny * off]);
  }
  return smooth(p);
}
function edge(r, fx, fy, pad = 10) { // the point on the edge of a box that faces (fx, fy)
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2, dx = fx - cx, dy = fy - cy;
  const s = Math.min((r.width / 2 + pad) / (Math.abs(dx) || 1e-6), (r.height / 2 + pad) / (Math.abs(dy) || 1e-6));
  return [cx + dx * s, cy + dy * s];
}

/* ---------- the pen ---------- */
const pen = { x: 0, y: 0, r: 0, vx: 0, vy: 0, home: true };
const DRAW_TILT = -48;
function penPaint() { penEl.style.transform = `translate(${pen.x}px,${pen.y}px) rotate(${pen.r}deg)`; }
function homePoint() { const s = $('slot').getBoundingClientRect(); return [s.left + 5, s.top + s.height / 2]; }
function penSnapHome() { const [x, y] = homePoint(); Object.assign(pen, { x, y, r: 0, vx: 0, vy: 0, home: true }); penPaint(); }
function penTo(x, y, r = DRAW_TILT) { // a spring: fast, with a small overshoot
  pen.home = false;
  return new Promise((done) => {
    const k = 150, c = 19, r0 = pen.r, d0 = Math.hypot(x - pen.x, y - pen.y) || 1, t0 = performance.now();
    let last = t0;
    penEl.classList.add('fly');
    const step = (now) => {
      const dt = Math.min(.032, (now - last) / 1000); last = now;
      pen.vx += (k * (x - pen.x) - c * pen.vx) * dt; pen.vy += (k * (y - pen.y) - c * pen.vy) * dt;
      pen.x += pen.vx * dt; pen.y += pen.vy * dt;
      const left = Math.hypot(x - pen.x, y - pen.y);
      pen.r = r0 + (r - r0) * Math.max(0, Math.min(1, 1 - left / d0));
      penPaint();
      if ((left < .7 && Math.hypot(pen.vx, pen.vy) < 9) || now - t0 > 1500) {
        Object.assign(pen, { x, y, r, vx: 0, vy: 0 }); penPaint(); penEl.classList.remove('fly'); done();
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
async function penHome() { const [x, y] = homePoint(); await penTo(x, y, 0); pen.home = true; }
let drum = null; // while the chat looks, the pen drums in its tray
function drumOn() { if (drum) return; drum = penEl.firstElementChild.animate(
  [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-7deg)' }, { transform: 'rotate(0deg)' }, { transform: 'rotate(0deg)' }],
  { duration: 620, iterations: Infinity, easing: 'ease-in-out' }); }
function drumOff() { if (drum) { drum.cancel(); drum = null; } }

/* ---------- drawing ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tween = (ms, fn) => new Promise((done) => {
  const t0 = performance.now();
  const f = (now) => { const k = Math.min(1, (now - t0) / ms); fn(k); k < 1 ? requestAnimationFrame(f) : done(); };
  requestAnimationFrame(f);
});
function el(name, attrs, parent) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; }
function group() { const g = el('g', { class: 'mark' }, ink); return { g, under: el('g', {}, g), top: el('g', {}, g), text: el('g', {}, g) }; }

// One marker line: a dark line below, the yellow line on it. The pen flies to the start and draws it.
async function stroke(G, d, o = {}) {
  const w = o.w || 4.6, paths = [];
  if (!o.flat) paths.push(el('path', { d, class: 'u', 'stroke-width': w + 4.6 }, G.under));
  paths.push(el('path', { d, class: o.flat ? 'hl' : 't', 'stroke-width': w }, G.top));
  const top = paths[paths.length - 1], len = top.getTotalLength();
  for (const p of paths) { p.style.strokeDasharray = len + 2; p.style.strokeDashoffset = len + 2; }
  const p0 = top.getPointAtLength(0);
  if (!o.joined) await penTo(p0.x, p0.y);
  await tween(Math.max(o.min || 150, len / (o.speed || 1500) * 1000), (k) => {
    const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, off = (len + 2) * (1 - e);
    for (const p of paths) p.style.strokeDashoffset = off;
    const pt = top.getPointAtLength(len * e); pen.x = pt.x; pen.y = pt.y; penPaint();
  });
}
function tag(G, text, x, y, anchor = 'start') { // the number that the answer line points to
  if (text === '' || text == null) return;
  const t = el('text', { x: f1(x), y: f1(y), 'text-anchor': anchor }, G.text);
  t.textContent = text;
  t.animate([{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 280, easing: 'cubic-bezier(.3,1.7,.5,1)' });
}
async function head(G, d) { // the two short lines of an arrow head, at the end of path d
  const probe = el('path', { d }, G.under), len = probe.getTotalLength();
  const a = probe.getPointAtLength(len), b = probe.getPointAtLength(Math.max(0, len - 16));
  probe.remove();
  const ang = Math.atan2(a.y - b.y, a.x - b.x), L = 18;
  const w1 = [a.x - Math.cos(ang - .5) * L, a.y - Math.sin(ang - .5) * L], w2 = [a.x - Math.cos(ang + .55) * L, a.y - Math.sin(ang + .55) * L];
  await stroke(G, `M${f1(w1[0])},${f1(w1[1])} L${f1(a.x)},${f1(a.y)} L${f1(w2[0])},${f1(w2[1])}`, { speed: 900, joined: false });
}

/* ---------- the eight marks (the same functions as in the approved look) ---------- */
const mark = {
  async ring(r, n) {
    const G = group(), cx = r.x + r.width / 2, cy = r.y + r.height / 2, rx = r.width / 2 + 14, ry = r.height / 2 + 10;
    await stroke(G, ringPath(cx, cy, rx, ry));
    tag(G, n, cx - rx - 8, cy - ry + 4, 'end');
  },
  async arrow(r, fx, fy, n) { // from the point (fx, fy) to the thing; the number sits at the tail
    const G = group(), [tx, ty] = edge(r, fx, fy, 9), d = curve(fx, fy, tx, ty, .13), below = fy > r.bottom;
    tag(G, n, below ? fx + 10 : fx - 6, below ? fy + 12 : fy - 8, below ? 'start' : 'end');
    await stroke(G, d);
    await head(G, d);
  },
  async underline(r, n) {
    const G = group(), y = r.bottom + 2.5;
    await stroke(G, curve(r.x - 3, y, r.right + 4, y + jit(1.2), .012));
    await stroke(G, curve(r.right + 1, y + 5.5, r.x + r.width * .22, y + 6 + jit(1), -.012), { joined: true, speed: 1900 });
    tag(G, n, r.right + 9, r.bottom + 15);
  },
  async box(r, n) {
    const G = group(), p = 8, x1 = r.x - p - 3, y1 = r.y - p, x2 = r.right + p + 3, y2 = r.bottom + p, o = 6;
    tag(G, n, x1 - 8, y1 + 4, 'end');
    await stroke(G, curve(x1 - o, y1 + jit(1), x2 + o, y1 + jit(1.5), .008));
    await stroke(G, curve(x2 + jit(1), y1 - o, x2 + jit(1.5), y2 + o, .02), { joined: true });
    await stroke(G, curve(x2 + o, y2 + jit(1), x1 - o, y2 + jit(1.5), .008), { joined: true });
    await stroke(G, curve(x1 + jit(1), y2 + o, x1 + jit(1.5), y1 - o, .02), { joined: true });
  },
  async highlight(r, n) { // a highlighter band over the words; no dark line below it
    const G = group(), cy = r.y + r.height / 2;
    tag(G, n, r.x + 2, r.y - 7); // above the left end: left of the band often sits a face or an icon
    await stroke(G, curve(r.x - 4, cy + jit(.8), r.right + 5, cy + jit(.8), .004), { flat: true, w: r.height + 5, speed: 1100 });
  },
  async steps(rs, names) { // numbered stops with a dashed run from each stop to the next
    const G = group();
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i], cx = r.x + r.width / 2;
      if (i) {
        const a = rs[i - 1], ax = a.x + a.width / 2, ay = a.y + a.height / 2, cy = r.y + r.height / 2;
        const [sx, sy] = edge(a, cx, cy, 9), [ex, ey] = edge(r, ax, ay, 12);
        // stops in one row: the run hops over what is between them, about 28 px high
        const d = curve(sx, sy, ex, ey, Math.abs(ey - sy) < 30 ? -Math.min(.34, 28 / Math.hypot(ex - sx, ey - sy)) : .1);
        const probe = el('path', { d }, G.under), len = probe.getTotalLength();
        await penTo(sx, sy);
        for (let s = 0; s < len - 6; s += 23) { // one dash after the other, like a run drawn on a tactics board
          const p = [0, 5, 10, 15].map((k) => probe.getPointAtLength(Math.min(len, s + k)));
          await stroke(G, 'M' + p.map((q) => `${f1(q.x)},${f1(q.y)}`).join(' L'), { joined: true, speed: 1500, min: 30 });
        }
        probe.remove();
        await head(G, d);
      }
      await stroke(G, ringPath(cx, r.y + r.height / 2, r.width / 2 + 5, r.height / 2 + 5), { speed: 1700 });
      tag(G, names[i], cx, r.y - 15, 'middle');
    }
  },
  async cross(r, n) {
    const G = group(), p = 7;
    await stroke(G, curve(r.x - p, r.y - p, r.right + p, r.bottom + p, .03));
    await stroke(G, curve(r.right + p, r.y - p, r.x - p, r.bottom + p, -.03));
    tag(G, n, r.right + 2, r.y - 16, 'end');
  },
  async spotlight(r, n) { // everything goes dark, only this stays
    const G = group(), p = 12, x = r.x - p, y = r.y - p, w = r.width + p * 2, h = r.height + p * 2, k = 12;
    const hole = `M${x + k},${y} h${w - 2 * k} a${k},${k} 0 0 1 ${k},${k} v${h - 2 * k} a${k},${k} 0 0 1 ${-k},${k} h${-(w - 2 * k)} a${k},${k} 0 0 1 ${-k},${-k} v${-(h - 2 * k)} a${k},${k} 0 0 1 ${k},${-k} z`;
    $('dimp').setAttribute('d', `M0,0 H${innerWidth} V${innerHeight} H0 Z ${hole}`);
    $('dim').classList.add('on');
    await sleep(350);
    await stroke(G, ringPath(r.x + r.width / 2, r.y + r.height / 2, w / 2 + 8, h / 2 + 6));
    tag(G, n, x + w + 16, y + 4);
    await sleep(1900);
    $('dim').classList.remove('on');
  },
};

/* ---------- one mark of an answer. Boxes come from main.js, already in window units. ---------- */
const R = (b) => ({ x: b.x, y: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h });
function tail(r) { // where an arrow starts when the chat gave no start: below and to the right, or above near the screen edge
  let fx = r.x + r.width / 2 + 52, fy = r.bottom + 96;
  if (fy > innerHeight - 30) fy = r.y - 96;
  if (fx > innerWidth - 20) fx = r.x + r.width / 2 - 52;
  return [fx, fy];
}
function play(m) {
  if (m.kind === 'steps') {
    const names = m.stops.map((_s, i) => (m.names && m.names[i] != null) ? String(m.names[i]) : 'abcdefghij'[i] || String(i + 1));
    return mark.steps(m.stops.map(R), names);
  }
  const r = R(m);
  if (m.kind === 'arrow') { const [fx, fy] = m.from ? [m.from.x, m.from.y] : tail(r); return mark.arrow(r, fx, fy, m.n); }
  return (mark[m.kind] || mark.ring)(r, m.n);
}

/* ---------- the board ---------- */
let phase = 'idle';            // idle | wait | answer
let slot = { chat: '', light: 'grey' };
let cur = 0, askNo = 0, run = 0, last = null, t0 = 0, tick = null;
const signals = new Map();     // id -> what the chat's side has reported so far ('got', 'looks')

function stage(text, n) {
  $('stg').textContent = text; $('stg').title = text;
  document.querySelectorAll('.mag').forEach((m, i) => { const on = i < n; if (on && !m.classList.contains('on')) m.classList.add('snap'); m.classList.toggle('on', on); if (!on) m.classList.remove('snap'); });
}
function idleText() { return slot.light === 'green' ? 'Ready' : 'No chat waits'; }
function wipeNow() { run++; ink.innerHTML = ''; ink.classList.remove('wiped'); $('dim').classList.remove('on'); drumOff(); }
function fold(on) { card.classList.toggle('folded', on); if (pen.home) penSnapHome(); }

function showSlot(s) {
  slot = s;
  $('lamp').classList.toggle('green', s.light === 'green');
  $('chat').textContent = s.chat || 'no chat';
  $('link').title = s.light === 'green' ? `The chat "${s.chat}" holds the coach.` : 'No chat waits. Say "coach on" in a chat.';
  input.placeholder = s.light === 'green' ? 'Ask about your screen' : 'Say "coach on" in a chat first';
  if (phase === 'idle') stage(idleText(), 0);
  if (phase === 'wait' && cur && !signals.has(cur)) stage(s.light === 'green' ? 'Picture taken' : 'Picture taken. No chat waits.', 1);
}
function showSignal(id) { // the true stages of the wait
  if (phase !== 'wait' || id !== cur) return;
  const what = signals.get(id);
  if (what === 'got') stage('The chat has your question', 1);
  if (what === 'looks') { stage('I look at your screen', 2); drumOn(); }
}

async function submit(text) {
  const mine = ++askNo;
  wipeNow(); cur = 0; phase = 'wait'; last = null;
  card.classList.remove('has-a', 'done'); card.classList.add('has-q'); fold(false);
  $('q').textContent = text; $('lines').innerHTML = ''; input.value = '';
  t0 = performance.now(); clearInterval(tick);
  tick = setInterval(() => { $('clock').textContent = Math.floor((performance.now() - t0) / 1000) + ' s'; }, 200);
  $('clock').textContent = '0 s';
  stage('I take the picture', 0); penSnapHome(); penEl.classList.add('in');
  try {
    const r = await api.ask(text);
    if (mine !== askNo) return;
    cur = r.id;
    stage(slot.light === 'green' ? 'Picture taken' : 'Picture taken. No chat waits.', 1);
    showSignal(cur);
  } catch (err) {
    if (mine !== askNo) return;
    clearInterval(tick); phase = 'idle';
    stage('The picture failed', 0);
    $('q').textContent = text + ' (the picture failed: ' + (err && err.message || err) + ')';
  }
}

function showLines(a) {
  const used = new Set(a.marks.map((m) => m.n));
  $('lines').innerHTML = '';
  a.lines.forEach((t, i) => {
    const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('span');
    const n = String(i + 1);
    b.textContent = n; s.textContent = t; li.dataset.n = n; li.append(b, s);
    if (a.lines.length === 1 && !used.has(n)) li.classList.add('plain'); // one line and no mark: no number needed
    if (!used.has(n)) li.classList.add('on');                            // a line with no mark is ready at once
    $('lines').appendChild(li);
  });
}
async function draw(a) {
  const me = ++run, live = () => me === run;
  ink.innerHTML = ''; ink.classList.remove('wiped'); seed = 11 + a.id;
  card.classList.remove('done'); penSnapHome(); penEl.classList.add('in');
  const left = new Map(); // how many marks each number still waits for
  for (const m of a.marks) left.set(m.n, (left.get(m.n) || 0) + 1);
  document.querySelectorAll('#lines li').forEach((li) => { if (left.has(li.dataset.n)) li.classList.remove('on'); });
  for (const m of a.marks) {
    if (!live()) return false;
    try { await play(m); } catch (err) { console.log('MARK failed ' + m.kind + ': ' + (err && err.message || err)); }
    if (!live()) return false;
    left.set(m.n, left.get(m.n) - 1);
    if (!left.get(m.n)) { const li = document.querySelector(`#lines li[data-n="${CSS.escape(m.n)}"]`); if (li) li.classList.add('on'); }
    await sleep(260);
  }
  if (!live()) return false;
  if (a.marks.length) await penHome();
  stage('Done', 3); card.classList.add('done');
  return true;
}

api.onAnswer(async (a) => {
  if (a.id !== cur) return; // he asked again: this answer is old news
  clearInterval(tick); drumOff(); phase = 'answer'; last = a;
  $('clock').textContent = Math.round(a.wait) + ' s';
  stage('Answer', 3); showLines(a); card.classList.add('has-a'); fold(false);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // the board has its new size before the pen moves
  const ok = await draw(a);
  if (ok) api.drawn(a.id);
});
api.onStage((s) => { signals.set(s.id, s.what); showSignal(s.id); });
api.onSlot(showSlot);
api.onTest((t) => { if (t.ask) submit(t.ask); if (t.click) $(t.click).click(); });

/* ---------- the board is a real thing: you can move it, fold it and close it ---------- */
let over = false, drag = null;
card.addEventListener('mouseenter', () => { over = true; api.hit(true); });
card.addEventListener('mouseleave', () => { over = false; if (!drag) api.hit(false); });
$('bar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  const r = card.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
});
addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return; // a click, not a drag
  if (!drag.moved) { drag.moved = true; card.style.right = 'auto'; card.style.bottom = 'auto'; }
  card.style.left = Math.max(0, Math.min(innerWidth - 80, e.clientX - drag.dx)) + 'px';
  card.style.top = Math.max(0, Math.min(innerHeight - 60, e.clientY - drag.dy)) + 'px';
  if (pen.home) penSnapHome();
});
addEventListener('mouseup', () => {
  if (!drag) return;
  const click = !drag.moved; drag = null;
  if (!over) api.hit(false);
  if (click) { const open = card.classList.contains('folded'); fold(!open); if (open) input.focus(); } // a click on the bar opens or folds
});
$('fold').addEventListener('click', () => fold(!card.classList.contains('folded')));
$('close').addEventListener('click', () => api.quit());
$('wipe').addEventListener('click', () => { // the marks go and the board folds to its small tab
  run++; ink.classList.add('wiped'); $('dim').classList.remove('on');
  setTimeout(() => { ink.innerHTML = ''; ink.classList.remove('wiped'); }, 380);
  clearInterval(tick); drumOff(); phase = 'idle'; stage(idleText(), 0); $('clock').textContent = '';
  fold(true); penSnapHome(); // the answer text stays on the board: a click on the tab shows it again, "Draw again" draws it again
});
$('again').addEventListener('click', () => { if (last) draw(last); });
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = input.value.trim();
  if (text) submit(text);
});

card.classList.add('pop');
stage(idleText(), 0);
requestAnimationFrame(() => { penSnapHome(); penEl.classList.add('in'); });
console.log('COACH page ready');
