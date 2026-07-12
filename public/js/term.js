// Terminal page: xterm.js bridged to the tmux PTY over a WebSocket, with
// resilient auto-reconnect. This deliberately replaces ttyd's dead-end
// "Press ENTER to reconnect" overlay — which never worked on mobile because
// it only listens for a physical Enter key — with reconnect that fires
// automatically and on tap, on backoff, and the moment the tab is foregrounded.

const params = new URLSearchParams(location.search);
const session = params.get('s') || 'main';
document.title = `${session} · tmux`;

const statusEl = document.getElementById('status');

const savedFontSize = parseInt(localStorage.getItem('term-font-size') || '14', 10);
const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: savedFontSize,
  scrollback: 10000,
  allowProposedApi: true,
  theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

let ws = null;
let backoff = 500;          // ms, grows until a connection succeeds
let reconnectTimer = null;
let manualClose = false;
let fatalClose = false; // 1008 from the server: access denied — retrying can never succeed
let heartbeatTimer = null;   // interval that sends pings
let heartbeatTimeout = null; // per-ping death timer

function setStatus(text, cls) {
  statusEl.className = `status ${cls || ''}`.trim();
  statusEl.textContent = text;
}
function hideStatus() { statusEl.className = 'status hidden'; }

function doFit() {
  try { fit.fit(); } catch { /* not visible yet */ }
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function connect() {
  if (fatalClose) return;
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setStatus('Connecting…', 'reconnecting');
  doFit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?s=${encodeURIComponent(session)}&cols=${term.cols}&rows=${term.rows}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    backoff = 500;
    hideStatus();
    sendResize();
    startHeartbeat();
    term.focus();
  };

  ws.onmessage = (ev) => {
    if (ev.data === '__pong__') {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
      return;
    }
    if (typeof ev.data === 'string') term.write(ev.data);
    else term.write(new Uint8Array(ev.data)); // binary frame
    if (_scrolledUp) bottomBtn.classList.add('has-new');
  };

  ws.onclose = (ev) => {
    stopHeartbeat();
    if (manualClose) return;
    // 1008 = the gate refused this session (bad name / not signed in / another
    // tenant's session). Reconnecting can never succeed — say so and stop.
    if (ev.code === 1008) {
      fatalClose = true;
      const why = ev.reason === 'auth required'
        ? 'Sign in required — sign in on the dashboard, then reload this page.'
        : `Access denied: ${ev.reason || 'this session is not available to you'}.`;
      setStatus(why, 'error');
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch { /* noop */ }
  };
}

function scheduleReconnect() {
  setStatus('Reconnecting… (tap to retry now)', 'reconnecting');
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.7, 10000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    heartbeatTimeout = setTimeout(() => {
      // No pong in 5 s — zombie connection, force close → triggers reconnect
      try { ws.close(); } catch { /* noop */ }
    }, 5000);
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 15000);
}
function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  clearTimeout(heartbeatTimeout);
  heartbeatTimer = null;
  heartbeatTimeout = null;
}

function sendInput(data) {
  if (data && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
}

// Scroll tmux's REAL history (not xterm's local buffer, which stays empty
// because tmux only repaints the visible screen on attach). With `mouse on`,
// tmux enters copy-mode on wheel-up and auto-exits when wheel-down reaches the
// bottom (the `-e` flag in its default WheelUp binding). We synthesize SGR
// mouse-wheel events because touch swipes aren't real wheel events to xterm.
// dir: 'up' = older, 'down' = newer.
function ptyWheel(dir, count) {
  if (!count) return;
  const btn = dir === 'up' ? 64 : 65;             // SGR wheel-up / wheel-down
  const col = Math.max(1, Math.floor(term.cols / 2));
  const row = Math.max(1, Math.floor(term.rows / 2));
  let seq = '';
  for (let i = 0; i < count; i++) seq += `\x1b[<${btn};${col};${row}M`;
  sendInput(seq);
}

// --- Ctrl modifier (the on-screen "Ctrl" key) -------------------------------
let ctrlArmed = false;
const ctrlBtn = document.getElementById('k-ctrl');
function setCtrl(on) {
  ctrlArmed = on;
  ctrlBtn.classList.toggle('active', on);
  ctrlBtn.setAttribute('aria-pressed', String(on));
}
function applyCtrl(data) {
  if (!ctrlArmed || data.length !== 1) return data;
  setCtrl(false);
  const ch = data.toLowerCase();
  if (ch >= 'a' && ch <= 'z') return String.fromCharCode(ch.charCodeAt(0) - 96); // ^A..^Z
  if (data === ' ') return '\x00'; // ^Space → NUL
  return data;
}

// Forward keystrokes / pastes to the PTY.
term.onData((data) => sendInput(applyCtrl(data)));

// --- Scroll mode (tmux copy mode) ------------------------------------------
let scrollMode = false;
const scrollBtn = document.getElementById('k-scroll');
function setScrollMode(on) {
  scrollMode = on;
  scrollBtn.classList.toggle('active', on);
  scrollBtn.setAttribute('aria-pressed', String(on));
  // Enter tmux copy mode (Ctrl+b [) or exit with q
  if (on) {
    sendInput('\x02['); // Ctrl+b [
  } else {
    sendInput('q');
  }
  term.focus();
}
scrollBtn.addEventListener('click', () => setScrollMode(!scrollMode));

// --- Scroll-to-bottom button -------------------------------------------
const bottomBtn = document.getElementById('k-bottom');
let _scrolledUp = false;

function _updateBottomBtn() {
  const buf = term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  if (atBottom === _scrolledUp) {
    _scrolledUp = !atBottom;
    bottomBtn.classList.toggle('visible', !atBottom);
    if (atBottom) bottomBtn.classList.remove('has-new');
  }
}

term.onScroll(() => _updateBottomBtn());

bottomBtn.addEventListener('click', () => {
  term.scrollToBottom();
  bottomBtn.classList.remove('has-new');
  term.focus();
});

// --- On-screen helper keys --------------------------------------------------
const KEYS = {
  esc: '\x1b', tab: '\t', enter: '\r',
  prefix: '\x02', ctrlc: '\x03',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  pgup: '\x1b[5~', pgdn: '\x1b[6~',
  home: '\x1b[H', end: '\x1b[F',
  wordleft: '\x1bb', wordright: '\x1bf',
};
const keybar = document.getElementById('keybar');
let keybarCollapsed = false; // declared early so layout() can read it
const cmdbarEl = document.getElementById('cmdbar');  // declared early so layout() can read it
let cmdbarVisible = false;
// Stop the buttons from stealing focus so the soft keyboard stays open.
keybar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
keybar.querySelectorAll('[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => { sendInput(applyCtrl(KEYS[btn.dataset.key]) ?? KEYS[btn.dataset.key]); term.focus(); });
});
ctrlBtn.addEventListener('click', () => { setCtrl(!ctrlArmed); term.focus(); });

// --- Select All button ------------------------------------------------------
document.getElementById('k-selall').addEventListener('click', () => {
  term.selectAll();
  term.focus();
});

// --- Copy button: copies selection (selects all first if nothing selected) --
document.getElementById('k-copy').addEventListener('click', async () => {
  let sel = term.getSelection();
  if (!sel) {
    term.selectAll();
    sel = term.getSelection();
  }
  if (sel) {
    try { await navigator.clipboard.writeText(sel); } catch { /* denied */ }
  }
  term.clearSelection();
  term.focus();
});

document.getElementById('k-paste').addEventListener('click', async () => {
  try { sendInput(await navigator.clipboard.readText()); } catch { /* denied */ }
  term.focus();
});

// --- Auto-copy on select ----------------------------------------------------
// Just highlighting text in the terminal drops it straight onto the clipboard —
// no hunting for the Copy button. The write happens inside the selection-change
// event (still part of the user's drag/long-press gesture), which is what iOS
// Safari requires for clipboard access. A short status flash confirms it.
let _copyFlashTimer = null;
function flashCopied(n) {
  setStatus(`Copied ${n} char${n === 1 ? '' : 's'}`, 'ok');
  clearTimeout(_copyFlashTimer);
  _copyFlashTimer = setTimeout(hideStatus, 1200);
}
let _lastCopied = '';
term.onSelectionChange(() => {
  const sel = term.getSelection();
  if (!sel || sel === _lastCopied) return; // skip empty + redundant re-fires during a drag
  _lastCopied = sel;
  navigator.clipboard.writeText(sel).then(() => flashCopied(sel.length)).catch(() => { /* denied / not focused */ });
});

// --- Sudo toggle: per-session passwordless sudo (revocable any time) --------
// Some sessions need to touch paths outside the project dir (root-owned). This
// flips a sudoers rule on the server so `sudo` works without a password in this
// session; toggle it back off to withdraw it (keep a human in the loop). The
// button turns red while active as a reminder that root is unlocked.
const sudoBtn = document.getElementById('k-sudo');
function setSudoBtn(on) {
  sudoBtn.classList.toggle('active', on);
  sudoBtn.setAttribute('aria-pressed', String(on));
}
function flashStatus(text, cls, ms) {
  setStatus(text, cls);
  clearTimeout(_copyFlashTimer);
  _copyFlashTimer = setTimeout(hideStatus, ms || 1400);
}
async function refreshSudo() {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/sudo`);
    if (r.ok) setSudoBtn(!!(await r.json()).enabled);
  } catch { /* offline — leave as-is */ }
}
sudoBtn.addEventListener('click', async () => {
  const want = !sudoBtn.classList.contains('active');
  setSudoBtn(want); // optimistic
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/sudo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: want }),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    setSudoBtn(!!(await r.json()).enabled);
    flashStatus(want ? 'sudo enabled for this session' : 'sudo disabled', want ? 'ok' : 'reconnecting');
  } catch {
    setSudoBtn(!want); // revert
    flashStatus('sudo toggle failed', 'error', 1800);
  }
  term.focus();
});
refreshSudo();

// --- Font size controls (A+ / A−) + pinch-to-zoom -------------------------
function setFontSize(n) {
  n = Math.max(9, Math.min(24, n));
  term.options.fontSize = n;
  localStorage.setItem('term-font-size', n);
  doFit();
  sendResize();
}

document.getElementById('k-font-up').addEventListener('click', () => { setFontSize(term.options.fontSize + 1); term.focus(); });

// Keybar collapse (landscape space-saver) ---------------------------------
const keybarEl = document.getElementById('keybar');
const hideBtn  = document.getElementById('k-hide');
// --- Command bar -------------------------------------------------------
const cmdInput = document.getElementById('cmd-input');
const cmdSend  = document.getElementById('cmd-send');
const cmdClose = document.getElementById('cmd-close');
const cmdBtn   = document.getElementById('k-cmd');

function sendCmd() {
  const text = cmdInput.value;
  if (!text) return;
  sendInput(text + '\r');
  cmdInput.value = '';
  cmdInput.focus();
}

function showCmdbar(on) {
  cmdbarVisible = on;
  cmdbarEl.classList.toggle('visible', on);
  cmdBtn.classList.toggle('active', on);
  cmdBtn.setAttribute('aria-pressed', String(on));
  layout();
  if (on) cmdInput.focus(); else term.focus();
}

cmdBtn.addEventListener('click', () => showCmdbar(!cmdbarVisible));
cmdSend.addEventListener('click', sendCmd);
cmdClose.addEventListener('click', () => showCmdbar(false));
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); sendCmd(); }
  if (e.key === 'Escape') { e.preventDefault(); showCmdbar(false); }
});

function toggleKeybar() {
  keybarCollapsed = !keybarCollapsed;
  keybarEl.classList.toggle('collapsed', keybarCollapsed);
  document.body.classList.toggle('kb-collapsed', keybarCollapsed);
  hideBtn.innerHTML  = keybarCollapsed ? '⌄ show' : '⌃ hide';
  hideBtn.setAttribute('aria-label', keybarCollapsed ? 'Show keybar' : 'Hide keybar');
  layout();
}
hideBtn.addEventListener('click', () => { toggleKeybar(); term.focus(); });
document.getElementById('k-font-dn').addEventListener('click', () => { setFontSize(term.options.fontSize - 1); term.focus(); });

// Declared here because the touch/pinch/edge-swipe handlers below reference it;
// a `const` used before its declaration throws a ReferenceError (temporal dead
// zone) that aborts the whole script before connect() runs — blank terminal.
const termEl = document.getElementById('term');

// Pinch-to-zoom: two-finger spread/pinch adjusts font size
let pinchStartDist = 0;
let pinchStartSize = 14;
// Swipe-right from left edge → back to sessions list -----------------
let edgeSwipeStartX = 0;
let edgeSwipeStartY = 0;
let isEdgeSwipe = false;
const EDGE_ZONE = 28; // px from left edge that triggers the gesture

termEl.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    edgeSwipeStartX = e.touches[0].clientX;
    edgeSwipeStartY = e.touches[0].clientY;
    isEdgeSwipe = edgeSwipeStartX <= EDGE_ZONE;
  }
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchStartSize = term.options.fontSize;
  }
}, { passive: true });

termEl.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  const dist = Math.hypot(dx, dy);
  const newSize = Math.round(pinchStartSize * dist / pinchStartDist);
  setFontSize(newSize);
}, { passive: false });

// --- Touch scrolling on the terminal area -----------------------------------
// A vertical swipe scrolls tmux's history (via ptyWheel); a tap focuses the
// terminal and opens the soft keyboard. Natural direction: swipe down = older.
let touchStartY = 0;
let touchStartX = 0;
let touchScrolling = false;
const SWIPE_THRESHOLD = 8;  // px before we decide it's a scroll, not a tap
const PX_PER_WHEEL = 22;    // px of swipe per wheel tick (higher = slower scroll)

termEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStartY = e.touches[0].clientY;
  touchStartX = e.touches[0].clientX;
  touchScrolling = false;
}, { passive: true });

termEl.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 1) return;
  const dy = touchStartY - e.touches[0].clientY;
  const dx = touchStartX - e.touches[0].clientX;

  // Only engage scroll mode when vertical motion dominates
  if (!touchScrolling && Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
    touchScrolling = true;
  }
  if (!touchScrolling) return;

  // Prevent the page from scrolling; forward the swipe to tmux as wheel ticks.
  e.preventDefault();
  const ticks = Math.trunc(dy / PX_PER_WHEEL);
  if (ticks !== 0) {
    // dy>0 = finger swiped up = reveal newer (wheel down); dy<0 = older (wheel up).
    ptyWheel(ticks > 0 ? 'down' : 'up', Math.abs(ticks));
    touchStartY = e.touches[0].clientY; // reset so each frame moves by delta
  }
}, { passive: false });

termEl.addEventListener('touchend', (e) => {
  // Edge swipe-right → back to sessions
  if (isEdgeSwipe && e.changedTouches.length === 1) {
    const dx = e.changedTouches[0].clientX - edgeSwipeStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - edgeSwipeStartY);
    if (dx > 60 && dy < 80) { location.href = '/'; return; }
  }
  isEdgeSwipe = false;
  if (!touchScrolling) {
    // It was a tap — focus the terminal to open keyboard
    term.focus();
  }
  touchScrolling = false;
}, { passive: true });

// --- Layout: keep the terminal + key bar above the soft keyboard ------------
function layout() {
  const vv = window.visualViewport;
  const gap = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
  keybar.style.bottom = `${gap}px`;
    // When collapsed the keybar is translated fully off-screen; give terminal the space.
  const kbH = keybarCollapsed ? 0 : keybar.offsetHeight;
  // Position cmdbar above keybar; include its height so the terminal doesn't overlap.
  const cmdH = cmdbarVisible ? cmdbarEl.offsetHeight : 0;
  cmdbarEl.style.bottom = `${gap + kbH}px`;
  document.documentElement.style.setProperty('--keybar-h', `${kbH + cmdH + gap}px`);
  doFit();
  sendResize();
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', layout);
  visualViewport.addEventListener('scroll', layout);
}

const ro = new ResizeObserver(() => layout());
ro.observe(termEl);
window.addEventListener('orientationchange', () => setTimeout(layout, 200));
layout();

// Reconnect immediately when the tab becomes visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    backoff = 500;
    connect();
  }
});
window.addEventListener('online', () => { backoff = 500; connect(); });
window.addEventListener('focus', connect);

// Tapping/clicking the status pill forces an immediate reconnect.
statusEl.addEventListener('click', () => {
  if (fatalClose) return; // access-denied is permanent; tapping shouldn't resurrect the loop
  backoff = 500; connect();
});
statusEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (fatalClose) return; // access-denied is permanent; tapping shouldn't resurrect the loop
  backoff = 500; connect();
});

window.addEventListener('beforeunload', () => {
  manualClose = true;
  if (ws) try { ws.close(); } catch { /* noop */ }
});

connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
