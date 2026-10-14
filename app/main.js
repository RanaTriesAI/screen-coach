// Screen Coach: one see-through window over the main screen.
// The board sends a question + one screenshot to <data>/inbox.
// The running Claude Code chat answers through <data>/outbox. This file shows the answer and logs the seconds.
//
// Start:  electron <this folder> --data=<folder>      (bridge/coach-on.ps1 does this)
// Test:   add --cotest: the real board in a window that is never shown. This file plays the chat.
//         No screenshot is taken. Frames go to <data>/cotest-frames/, the log to <data>/app.log.

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const COTEST = process.argv.includes('--cotest');
const REAL = !COTEST;
const DATA_ARG = process.argv.find((a) => a.startsWith('--data='));
const BASE = DATA_ARG ? path.resolve(DATA_ARG.slice('--data='.length)) : path.join(app.getPath('appData'), 'screen-coach');
const DATA = COTEST ? path.join(BASE, 'cotest') : BASE;          // the unseen test never touches the real slot
const OUT = path.join(BASE, 'cotest-frames');
const SHOTS = path.join(DATA, 'shots');
const INBOX = path.join(DATA, 'inbox');
const OUTBOX = path.join(DATA, 'outbox');
const SLOT = path.join(DATA, 'slot');                            // the link: which chat holds the coach
const OWNER = path.join(SLOT, 'owner.json');                     // written by bridge/coach.ps1 when a chat arms the slot
const BEAT = path.join(SLOT, 'beat');                            // touched every second while that chat waits
const APPJSON = path.join(SLOT, 'app.json');                     // "the board is up", with its process number
const LOG = path.join(DATA, 'log.csv');
const APPLOG = path.join(BASE, 'app.log');
const STOP = path.join(INBOX, 'STOP');
const LASTID = path.join(DATA, 'last-id.txt');
const PAGE = path.join(__dirname, 'coach.html');
const KINDS = ['ring', 'arrow', 'underline', 'box', 'highlight', 'steps', 'cross', 'spotlight'];

for (const d of [BASE, SHOTS, INBOX, OUTBOX, SLOT]) fs.mkdirSync(d, { recursive: true });
app.setPath('userData', path.join(BASE, 'chromium'));            // Chromium's own cache stays inside the coach's folder

function note(msg) {
  const line = new Date().toISOString() + '  ' + msg + '\n';
  try { fs.appendFileSync(APPLOG, line); } catch (e) { /* the log must never stop the app */ }
}
process.on('uncaughtException', (e) => note('UNCAUGHT ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => note('REJECTION ' + (e && e.stack || e)));

// One board at a time: a second real start ends at once and changes nothing.
const SECOND = REAL && !app.requestSingleInstanceLock();
if (SECOND) { note('START refused: a board is up already'); app.exit(0); }

const pad = (n) => String(n).padStart(4, '0');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// Only the board's own page may talk to this file.
const PAGE_URL = decodeURIComponent(pathToFileURL(PAGE).href).toLowerCase();
const fromBoard = (e) => {
  const u = e && e.senderFrame && e.senderFrame.url;
  return !!u && decodeURIComponent(u).split(/[?#]/)[0].toLowerCase() === PAGE_URL;
};

// The next id continues after the last one ever used (last-id.txt), so a number is never used twice,
// also after the clean-up has removed the old question files.
function highestId() {
  let max = 0;
  try { max = parseInt(fs.readFileSync(LASTID, 'utf8'), 10) || 0; } catch (e) { /* first run */ }
  for (const f of fs.readdirSync(INBOX)) {
    const m = /^q-(\d+)\.json$/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}
let lastId = highestId();

// CLEAN-UP. Screenshots can show private things, so they go by themselves.
// Screenshots, questions and answers go to the Recycle Bin, never a hard delete. `keep` = how many of the newest questions stay.
// The two kinds of empty flag files (q-N.got, s-N.json) hold nothing: they are removed like the STOP flag.
async function cleanUp(keep, why) {
  if (COTEST) return 0;
  const idOf = (f) => { const m = /^[qas]-(\d+)/.exec(f); return m ? parseInt(m[1], 10) : 0; };
  const limit = keep > 0 ? lastId - keep : Infinity;
  const files = [];
  for (const [dir, re] of [[SHOTS, /^[qa]-\d+.*\.png$/], [INBOX, /^q-\d+\.json$/], [OUTBOX, /^a-\d+\.json(\.tmp)?$/]]) {
    for (const f of fs.readdirSync(dir)) if (re.test(f) && idOf(f) <= limit) files.push(path.join(dir, f));
  }
  for (const [dir, re] of [[INBOX, /^q-\d+\.got$/], [OUTBOX, /^s-\d+\.json$/]]) {
    for (const f of fs.readdirSync(dir)) if (re.test(f) && idOf(f) <= limit) fs.rmSync(path.join(dir, f), { force: true });
  }
  let n = 0;
  for (const f of files) {
    try { await shell.trashItem(f); n++; } catch (e) { note('CLEAN could not move ' + f + ': ' + e.message); }
  }
  if (n || why !== 'ask') note(`CLEAN (${why}): ${n} of ${files.length} files to the Recycle Bin`);
  return n;
}

let win = null;
const pending = new Map(); // id -> { t0, text, shotMs, got, looks }
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

async function shoot() {
  const d = screen.getPrimaryDisplay();
  const size = {
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  return src.thumbnail; // a NativeImage in real pixels
}

function createWindow() {
  const d = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height - 1, // one pixel short: Windows must not treat it as a fullscreen app
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false, // with the thick frame, Windows cuts the window off above the taskbar
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: COTEST, // an unseen window that still runs its animations
    },
  });
  // The board is one local page: no other page, no new window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks go through to the app below
  win.setContentProtection(true); // the board stays out of its own screenshots
  win.loadFile(PAGE);
  win.once('ready-to-show', () => {
    if (COTEST) return; // the test frames come from a window that is never shown
    win.showInactive();
    // Two units short of the full height: a window that covers the whole screen counts as a fullscreen app.
    win.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height - 2 });
    note(`WINDOW up  display=${d.size.width}x${d.size.height} dip  scale=${d.scaleFactor}  bounds=${JSON.stringify(win.getBounds())}  onTop=${win.isAlwaysOnTop()}`);
  });
  win.webContents.on('console-message', (e) => note('PAGE ' + (e.message || '')));
  win.webContents.on('did-finish-load', () => { lastSlot = ''; sendSlot(); });
}

ipcMain.on('hit', (e, over) => {
  if (!win || !fromBoard(e)) return;
  if (over) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.handle('ask', async (e, text) => {
  if (!fromBoard(e)) throw new Error('not the board');
  text = String(text).slice(0, 2000);
  const t0 = Date.now();
  const id = ++lastId;
  try { fs.writeFileSync(LASTID, String(id)); } catch (err) { note('last-id not saved: ' + err.message); }
  cleanUp(3, 'ask'); // only the 3 newest questions keep their screenshots while the board is open
  const d = screen.getPrimaryDisplay();
  let shot = null;
  let size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  if (!COTEST) { // the unseen test takes no screenshot
    const img = await shoot();
    shot = path.join(SHOTS, `q-${pad(id)}.png`);
    fs.writeFileSync(shot, img.toPNG());
    size = img.getSize();
  }
  const tShot = Date.now();
  writeAtomic(path.join(INBOX, `q-${pad(id)}.json`), JSON.stringify({
    id, text, shot,
    sent: new Date(t0).toISOString(),
    picture: size,
    screen_dip: d.size,
    scale: d.scaleFactor,
  }, null, 2));
  pending.set(id, { t0, text, shotMs: tShot - t0, got: 0, looks: 0 });
  note(`ASK ${id}  picture=${size.width}x${size.height}  shot_ms=${tShot - t0}  chars=${text.length}  chat_waits=${slotState().waits}`);
  return { id };
});

ipcMain.on('quit', (e) => { if (fromBoard(e)) app.quit(); });

// THE LINK. A chat arms the slot with bridge/coach.ps1: that writes slot/owner.json (the chat's name) and touches
// slot/beat every second while it waits. The board shows the name and a light:
// green = that chat waits at the slot, or works on a question it took; grey = no chat waits.
let lastAnswerAt = 0, lastSlot = '';
function slotState() {
  let chat = '', beatAge = Infinity;
  try { chat = String(readJson(OWNER).chat || ''); } catch (e) { /* no chat has armed the slot */ }
  try { beatAge = Date.now() - fs.statSync(BEAT).mtimeMs; } catch (e) { /* no beat */ }
  const waits = !!chat && beatAge < 3500;
  let busy = false; // the chat took a question and has not answered yet (3 minutes at most)
  for (const p of pending.values()) if (p.got && Date.now() - p.t0 < 180000) busy = true;
  const grace = Date.now() - lastAnswerAt < 12000; // the chat arms the slot again in the same step as its answer
  return { chat, waits, light: chat && (waits || busy || grace) ? 'green' : 'grey' };
}
function sendSlot() {
  const s = slotState(), key = s.chat + '|' + s.light;
  if (key === lastSlot) return;
  lastSlot = key;
  send('slot', { chat: s.chat, light: s.light });
  note(`SLOT chat="${s.chat}" light=${s.light}`);
}

// The chat writes outbox/a-NNNN.json. Shape:
// { "id": 1, "w": 2000, "h": 837, "lines": ["First line.", "Second line."],
//   "marks": [ { "kind": "ring", "n": 1, "x": 100, "y": 50, "w": 80, "h": 24 },
//              { "kind": "arrow", "n": 2, "x": .., "y": .., "w": .., "h": .., "from": { "x": .., "y": .. } },
//              { "kind": "steps", "n": 3, "stops": [ { "x": .., "y": .., "w": .., "h": .. }, ... ] } ],
//   "check": true }
// x, y, w, h = the box of the thing (top left corner + size) in pixels of the screenshot AS THE CHAT SAW IT;
// the top-level w and h are the size of that picture. "n" ties a mark to the line with that number.
// Also read: "text" (one string, in place of "lines") and "points" ([{ x, y, label }], centre points).
function toMarks(a, d) {
  const sx = d.size.width / a.w, sy = d.size.height / a.h;
  const box = (m) => (m.w > 0 && m.h > 0)
    ? { x: m.x * sx, y: m.y * sy, w: m.w * sx, h: m.h * sy }
    : { x: m.x * sx - 18, y: m.y * sy - 18, w: 36, h: 36 }; // no size given: x and y are a centre point
  const marks = [];
  (a.marks || []).forEach((m, i) => {
    const kind = KINDS.includes(m.kind) ? m.kind : 'ring';
    const o = { kind, n: String(m.n != null ? m.n : i + 1) };
    if (kind === 'steps') {
      o.stops = (m.stops || []).map(box);
      o.names = m.names;
      if (!o.stops.length) return;
    } else Object.assign(o, box(m));
    if (m.from) o.from = { x: m.from.x * sx, y: m.from.y * sy };
    marks.push(o);
  });
  (a.points || []).forEach((p, i) => marks.push(Object.assign({ kind: 'ring', n: String(p.label || i + 1) }, box(p))));
  return marks;
}

const done = new Set();
const wantCheck = new Set();
const drawnIds = new Set();
// Answers of an earlier run are old news: never show them again after a restart.
for (const f of fs.readdirSync(OUTBOX)) {
  const m = /^a-(\d+)\.json$/.exec(f);
  if (m) done.add(parseInt(m[1], 10));
}
let ticks = 0;
function poll() {
  let files = [];
  // 1. the slot handed a question to the chat (bridge/coach.ps1 writes q-NNNN.got as it ends)
  try { files = fs.readdirSync(INBOX); } catch (e) { files = []; }
  for (const f of files) {
    const m = /^q-(\d+)\.got$/.exec(f);
    const p = m && pending.get(parseInt(m[1], 10));
    if (!p || p.got) continue;
    p.got = Date.now();
    if (!p.looks) send('stage', { id: parseInt(m[1], 10), what: 'got' });
    note(`GOT ${parseInt(m[1], 10)}  after_s=${((p.got - p.t0) / 1000).toFixed(1)}`);
  }
  // 2. the chat's first step (it writes s-NNNN.json when it opens the screenshot), and its answer
  try { files = fs.readdirSync(OUTBOX); } catch (e) { files = []; }
  for (const f of files) {
    const s = /^s-(\d+)\.json$/.exec(f);
    if (s) {
      const p = pending.get(parseInt(s[1], 10));
      if (p && !p.looks) {
        p.looks = Date.now(); if (!p.got) p.got = p.looks;
        send('stage', { id: parseInt(s[1], 10), what: 'looks' });
        note(`LOOKS ${parseInt(s[1], 10)}  after_s=${((p.looks - p.t0) / 1000).toFixed(1)}`);
      }
      continue;
    }
    const m = /^a-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (done.has(id)) continue;
    let a;
    try { a = readJson(path.join(OUTBOX, f)); }
    catch (e) { continue; } // half-written file: read it again on the next tick
    done.add(id);
    const p = pending.get(id);
    if (!p) { note(`ANSWER ${id} has no open question in this run`); continue; }
    pending.delete(id);
    const tA = Date.now();
    lastAnswerAt = tA;
    const wait = ((tA - p.t0) / 1000).toFixed(1);
    const d = screen.getPrimaryDisplay();
    let marks = [], lines = [];
    try {
      if (!(a.w > 0 && a.h > 0)) { a.w = d.size.width; a.h = d.size.height; if ((a.marks || a.points || []).length) note(`ANSWER ${id} names no picture size (w, h): the marks are read as window units`); }
      marks = toMarks(a, d);
      lines = Array.isArray(a.lines) ? a.lines.map(String) : String(a.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch (e) { note(`ANSWER ${id} could not be read: ${e.message}`); lines = [String(a.text || 'The answer file could not be read. Look at the chat.')]; }
    const text = lines.join('\n');
    send('answer', { id, lines, marks, wait });
    const secs = (t) => t ? ((t - p.t0) / 1000).toFixed(1) : '';
    if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, 'id,sent,answered,wait_s,shot_ms,got_s,looks_s,marks,question_chars,answer_chars\n');
    fs.appendFileSync(LOG, [id, new Date(p.t0).toISOString(), new Date(tA).toISOString(), wait, p.shotMs, secs(p.got), secs(p.looks), marks.length, p.text.length, text.length].join(',') + '\n');
    note(`ANSWER ${id}  wait_s=${wait}  lines=${lines.length}  marks=${marks.map((k) => k.kind).join('+') || '-'}`);
    if (a.check) wantCheck.add(id); // the proof picture waits until the pen has drawn every mark
  }
  // 3. the light, about twice a second
  if (++ticks % 3 === 0) sendSlot();
}

ipcMain.on('drawn', (e, id) => {
  if (!fromBoard(e)) return;
  drawnIds.add(id);
  note(`DRAWN ${id}`);
  if (wantCheck.delete(id) && !COTEST) setTimeout(() => checkShot(id), 250);
});

// A proof picture WITH the marks in it, so the chat can see where its own marks landed.
async function checkShot(id) {
  try {
    win.setContentProtection(false);
    await new Promise((r) => setTimeout(r, 350));
    const img = await shoot();
    fs.writeFileSync(path.join(SHOTS, `a-${pad(id)}-check.png`), img.toPNG());
    note(`CHECK ${id} saved`);
  } catch (e) {
    note('CHECK failed ' + e.message);
  } finally {
    win.setContentProtection(true);
  }
}

// --cotest: the real board in a window that is never shown. This file plays the chat:
// it arms a fake slot, asks a question through the page, sends the true stages and an answer with all eight marks.
// No screenshot is taken. Frames go to cotest-frames/ for the builder's own check.
async function cotest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(OUT, { recursive: true });
  const frame = async (name) => {
    try {
      const page = (await win.webContents.capturePage()).resize({ width: 1720 });
      fs.writeFileSync(path.join(OUT, `cotest-${name}.png`), page.toPNG());
    } catch (e) { note('COTEST frame failed ' + e.message); }
  };
  const beatOn = () => { fs.writeFileSync(BEAT, String(Date.now())); return setInterval(() => fs.writeFileSync(BEAT, String(Date.now())), 1000); };
  const state = (label) => win.webContents.executeJavaScript(`JSON.stringify({
      stage: document.getElementById('stg').textContent, mags: document.querySelectorAll('.mag.on').length,
      lamp: document.getElementById('lamp').className, chat: document.getElementById('chat').textContent,
      folded: document.getElementById('card').classList.contains('folded'), lines: document.querySelectorAll('#lines li').length,
      linesOn: document.querySelectorAll('#lines li.on').length, marks: document.querySelectorAll('#ink .mark').length,
      clock: document.getElementById('clock').textContent, card: (() => { const r = document.getElementById('card').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() })`)
    .then((s) => note(`COTEST ${label} ${s}`));
  let beat = null;
  try {
    win.webContents.setFrameRate(30);
    // a light half and a dark half behind the see-through window, so the marks can be judged on both
    await win.webContents.insertCSS('html { background: linear-gradient(90deg, #F3F4F6 0 50%, #1C1F26 50% 100%) !important; }');
    await wait(1300); await state('1-start'); await frame('1-start-no-chat');

    fs.writeFileSync(OWNER, JSON.stringify({ chat: 'Demo chat', pid: 1 }));
    beat = beatOn();
    await wait(1500); await state('2-chat-waits'); await frame('2-chat-waits');

    send('test', { ask: 'Where do I change the team name, and what must I not press?' });
    await wait(1000); await state('3-picture-taken'); await frame('3-picture-taken');
    let id = lastId;
    clearInterval(beat); beat = null; // the slot hands the question to the chat and ends
    fs.writeFileSync(path.join(INBOX, `q-${pad(id)}.got`), '');
    await wait(700); await state('4-chat-has-it');
    fs.writeFileSync(path.join(OUTBOX, `s-${pad(id)}.json`), '{}');
    await wait(1600); await state('5-chat-looks'); await frame('5-chat-looks');

    writeAtomic(path.join(OUTBOX, `a-${pad(id)}.json`), JSON.stringify({
      id, w: 2000, h: 837, check: true,
      lines: ['The team name is in this field.', 'Save is here.', 'These words say what the page is for.', 'This table holds the players.',
        'Read this line first.', 'File, then Insert, then Share.', 'Do not press Delete.', 'Only this part matters now.'],
      marks: [
        { kind: 'ring', n: 1, x: 250, y: 110, w: 110, h: 24 },
        { kind: 'arrow', n: 2, x: 620, y: 120, w: 70, h: 24 },
        { kind: 'underline', n: 3, x: 1130, y: 112, w: 170, h: 22 },
        { kind: 'box', n: 4, x: 1500, y: 90, w: 230, h: 90 },
        { kind: 'highlight', n: 5, x: 220, y: 330, w: 340, h: 22 },
        { kind: 'steps', n: 6, stops: [{ x: 1090, y: 330, w: 56, h: 24 }, { x: 1230, y: 330, w: 66, h: 24 }, { x: 1380, y: 330, w: 62, h: 24 }] },
        { kind: 'cross', n: 7, x: 700, y: 520, w: 80, h: 26 },
        { kind: 'spotlight', n: 8, x: 250, y: 560, w: 170, h: 30 },
      ],
    }));
    beat = beatOn(); // the chat arms the slot again in the same step
    const tA = Date.now();
    for (const sec of [1.2, 4, 8, 12]) { await wait(Math.max(0, sec * 1000 - (Date.now() - tA))); await frame(`6-answer-${String(sec).replace('.', '_')}s`); }
    for (let i = 0; i < 100 && !drawnIds.has(id); i++) await wait(250);
    await wait(500); await state(`7-done drawn=${drawnIds.has(id)} draw_s=${((Date.now() - tA) / 1000).toFixed(1)}`); await frame('7-done');

    send('test', { click: 'wipe' });
    await wait(900); await state('8-wiped'); await frame('8-wiped-folded');

    // "text" + "points" in place of "lines" + "marks" must still work
    send('test', { ask: 'Old shape?' });
    await wait(900); id = lastId;
    writeAtomic(path.join(OUTBOX, `a-${pad(id)}.json`), JSON.stringify({ id, text: 'One line, old shape. The ring is at the centre.', w: 2000, h: 837, points: [{ x: 1000, y: 418.5, label: '1' }] }));
    for (let i = 0; i < 40 && !drawnIds.has(id); i++) await wait(250);
    await wait(400); await state(`9-old-shape drawn=${drawnIds.has(id)}`); await frame('9-old-shape');

    // an answer with no mark: one plain line
    send('test', { ask: 'No mark?' });
    await wait(900); id = lastId;
    writeAtomic(path.join(OUTBOX, `a-${pad(id)}.json`), JSON.stringify({ id, lines: ['Yes. This answer needs no mark on the screen.'] }));
    for (let i = 0; i < 40 && !drawnIds.has(id); i++) await wait(250);
    await wait(400); await state(`10-no-mark drawn=${drawnIds.has(id)}`); await frame('10-no-mark');
  } catch (e) {
    note('COTEST FAILED ' + (e && e.stack || e));
  }
  clearInterval(beat);
  note('COTEST done');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { note('COTEST data not removed: ' + e.message); }
  app.quit();
}

app.whenReady().then(async () => {
  if (SECOND) return;
  // The board needs no camera, microphone, location or other browser permission: every request is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Only a real run is a real start: the unseen test leaves the "board closed" flag as it is.
  if (REAL) {
    try { fs.rmSync(STOP, { force: true }); } catch (e) { /* no old stop flag */ }
    await cleanUp(0, 'start'); // screenshots left by a crash or a hard stop
    for (const f of [OWNER, BEAT]) fs.rmSync(f, { force: true }); // the chat of an earlier run is old news
    writeAtomic(APPJSON, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  }
  note(`START electron=${process.versions.electron} cotest=${COTEST} lastId=${lastId}`);
  createWindow();
  setInterval(poll, 150);
  if (COTEST) win.webContents.once('did-finish-load', () => setTimeout(cotest, 300));
  // Test only: --quit-after=3 closes a real run by itself after 3 seconds (it proves the clean-up at close).
  const qa = process.argv.find((a) => /^--quit-after=\d+$/.test(a));
  if (qa) setTimeout(() => app.quit(), parseInt(qa.split('=')[1], 10) * 1000);
});

app.on('window-all-closed', () => app.quit());

// When the board closes: first the "closed" flag for the chat, then every screenshot, question and answer
// of the run goes to the Recycle Bin. The app waits for that before it ends.
let closing = false;
app.on('before-quit', (e) => {
  if (!REAL || SECOND || closing) return;
  e.preventDefault();
  closing = true;
  try { fs.writeFileSync(STOP, new Date().toISOString()); } catch (err) { /* best effort */ }
  try { fs.rmSync(APPJSON, { force: true }); } catch (err) { /* best effort */ }
  cleanUp(0, 'close').finally(() => app.quit());
});
app.on('will-quit', () => note('QUIT'));
