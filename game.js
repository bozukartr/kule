// ── CONSTANTS ──────────────────────────────────────────────────────────────
const BH     = 34;       // block height (px)
const MIN_W  = 10;       // minimum overlap to survive
const COLORS = ['#FF6B6B','#FF922B','#FFD43B','#69DB7C','#4DABF7','#748FFC','#DA77F2','#F783AC','#63E6BE','#FFA94D'];

// ── FIREBASE ───────────────────────────────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const db  = firebase.database();
const UID = Math.random().toString(36).slice(2, 10);

// ── STATE ──────────────────────────────────────────────────────────────────
let myName = '', oppName = '', oppScore = 0;
let mySlot = '', gameId = '';
let gRef   = null;   // db ref → games/{id}/{mySlot}

let blocks = [], score = 0, gameOver = false, rafId = null;
let curX = 0, curW = 0, curDir = 1, curSpeed = 2.5;
let camY = 0, targetCam = 0;
let CW = 0, CH = 0;
let tapHintShown = true;

const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

// ── SCREENS ────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'screen-game') setTimeout(resizeCanvas, 60);
}

function resizeCanvas() {
  CW = canvas.offsetWidth;
  CH = canvas.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = CW * dpr;
  canvas.height = CH * dpr;
  ctx.scale(dpr, dpr);
}

// ── MATCHMAKING ────────────────────────────────────────────────────────────
function joinQueue() {
  const qRef = db.ref('queue/' + UID);
  qRef.set({ name: myName, ts: firebase.database.ServerValue.TIMESTAMP });
  qRef.onDisconnect().remove();

  // Second player in queue creates the game
  db.ref('queue').on('value', async snap => {
    const q = snap.val();
    if (!q) return;
    const sorted = Object.entries(q).sort((a, b) => a[1].ts - b[1].ts);
    if (sorted.length < 2 || sorted[1][0] !== UID) return;

    const [uid1, d1] = sorted[0];
    const [uid2, d2] = sorted[1];
    const gId = db.ref('games').push().key;
    await db.ref().update({
      [`queue/${uid1}`]: null,
      [`queue/${uid2}`]: null,
      [`games/${gId}`]: {
        p1: { uid: uid1, name: d1.name, score: 0, lost: false },
        p2: { uid: uid2, name: d2.name, score: 0, lost: false }
      }
    });
  });

  // Listen for a game that includes me (as p1 or p2)
  ['p1', 'p2'].forEach(slot => {
    db.ref('games').orderByChild(`${slot}/uid`).equalTo(UID)
      .limitToLast(1).on('child_added', snap => {
        db.ref('queue').off();
        db.ref('queue/' + UID).remove();

        const g    = snap.val();
        gameId     = snap.key;
        mySlot     = slot;
        const oSlot = slot === 'p1' ? 'p2' : 'p1';
        oppName    = g[oSlot].name;
        gRef       = db.ref(`games/${gameId}/${mySlot}`);

        document.getElementById('my-name').textContent  = myName;
        document.getElementById('opp-name').textContent = oppName;
        document.getElementById('tap-hint').style.display = 'block';
        tapHintShown = true;

        show('screen-game');
        initGame();
        watchOpponent(gameId, oSlot);
      });
  });
}

function watchOpponent(gId, oSlot) {
  db.ref(`games/${gId}/${oSlot}`).on('value', snap => {
    const d = snap.val();
    if (!d) return;
    oppScore = d.score;
    document.getElementById('opp-score').textContent = oppScore;
    if (d.lost && !gameOver) endGame(true);
  });
}

// ── GAME ───────────────────────────────────────────────────────────────────
function initGame() {
  score = 0; blocks = []; camY = 0; targetCam = 0; gameOver = false;
  document.getElementById('my-score').textContent = '0';

  const baseW = Math.round(CW * 0.68);
  blocks.push({ x: Math.round((CW - baseW) / 2), w: baseW, color: COLORS[0] });
  spawnBlock();

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function spawnBlock() {
  const last  = blocks[blocks.length - 1];
  curW     = last.w;
  curX     = 0;
  curDir   = 1;
  curSpeed = Math.min(2.5 + score * 0.09, 8);
}

function loop() {
  if (gameOver) return;

  curX += curDir * curSpeed;
  if (curX < 0 || curX + curW > CW) { curDir *= -1; curX += curDir * curSpeed; }

  // Camera: keep moving block ~30% from top
  targetCam = Math.max(0, (blocks.length + 1) * BH - CH * 0.7);
  camY += (targetCam - camY) * 0.07;

  draw();
  rafId = requestAnimationFrame(loop);
}

// ── DRAW ───────────────────────────────────────────────────────────────────
function draw() {
  // bg
  ctx.fillStyle = '#0d0f1a';
  ctx.fillRect(0, 0, CW, CH);

  // shadow wall (left/right edges)
  const gL = ctx.createLinearGradient(0, 0, 40, 0);
  gL.addColorStop(0, 'rgba(13,15,26,0.7)'); gL.addColorStop(1, 'transparent');
  const gR = ctx.createLinearGradient(CW, 0, CW - 40, 0);
  gR.addColorStop(0, 'rgba(13,15,26,0.7)'); gR.addColorStop(1, 'transparent');
  ctx.fillStyle = gL; ctx.fillRect(0, 0, 40, CH);
  ctx.fillStyle = gR; ctx.fillRect(CW - 40, 0, 40, CH);

  // placed blocks
  blocks.forEach((b, i) => {
    const y = CH - (i + 1) * BH - camY;
    if (y > CH || y + BH < -20) return; // skip offscreen
    ctx.fillStyle = b.color;
    drawRound(b.x, y, b.w, BH - 3, 6);

    // top shine
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    drawRound(b.x + 2, y + 2, b.w - 4, 6, 3);
  });

  // moving block
  const mY = CH - (blocks.length + 1) * BH - camY;
  ctx.fillStyle = COLORS[blocks.length % COLORS.length];
  ctx.globalAlpha = 0.9;
  drawRound(curX, mY, curW, BH - 3, 6);

  // glow under moving block
  ctx.shadowColor = COLORS[blocks.length % COLORS.length];
  ctx.shadowBlur  = 18;
  drawRound(curX, mY + BH - 8, curW, 5, 3);
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;
}

function drawRound(x, y, w, h, r) {
  if (w < 1) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// ── TAP ────────────────────────────────────────────────────────────────────
function onTap() {
  if (gameOver) return;

  // Hide hint after first tap
  if (tapHintShown) {
    document.getElementById('tap-hint').style.display = 'none';
    tapHintShown = false;
  }

  const last    = blocks[blocks.length - 1];
  const left    = Math.max(curX, last.x);
  const right   = Math.min(curX + curW, last.x + last.w);
  const overlap = right - left;

  if (overlap <= MIN_W) { return loseGame(); }

  // Perfect snap (within 5px of perfect alignment)
  const isPerfect = Math.abs(left - last.x) < 5 && Math.abs(right - (last.x + last.w)) < 5;
  const nx = isPerfect ? last.x : left;
  const nw = isPerfect ? last.w : overlap;

  blocks.push({ x: nx, w: nw, color: COLORS[blocks.length % COLORS.length] });
  score++;
  document.getElementById('my-score').textContent = score;
  gRef && gRef.update({ score, lost: false });

  spawnBlock();
  if (navigator.vibrate) navigator.vibrate(isPerfect ? [10, 30, 10] : 12);
}

// ── END ────────────────────────────────────────────────────────────────────
function loseGame() {
  gameOver = true;
  cancelAnimationFrame(rafId);
  gRef && gRef.update({ lost: true, score });
  showResult(false);
}

function endGame(iWon) {
  if (gameOver) return;
  gameOver = true;
  cancelAnimationFrame(rafId);
  showResult(iWon);
}

function showResult(iWon) {
  document.getElementById('result-icon').textContent  = iWon ? '🏆' : '💀';
  document.getElementById('result-title').textContent = iWon ? 'YOU WIN!' : 'YOU LOSE!';
  document.getElementById('result-scores').innerHTML  =
    `<div>${myName} <b>${score}</b></div><div>${oppName} <b>${oppScore}</b></div>`;
  show('screen-result');
  cleanup();
}

function cleanup() {
  db.ref('queue').off();
  if (gameId) {
    const oSlot = mySlot === 'p1' ? 'p2' : 'p1';
    db.ref(`games/${gameId}/${oSlot}`).off();
  }
  ['p1', 'p2'].forEach(s =>
    db.ref('games').orderByChild(`${s}/uid`).equalTo(UID).off()
  );
  gameId = ''; gRef = null;
}

// ── EVENTS ────────────────────────────────────────────────────────────────
document.getElementById('btn-play').onclick = () => {
  myName = document.getElementById('player-name').value.trim() || 'Player';
  show('screen-queue');
  joinQueue();
};

document.getElementById('btn-cancel').onclick = () => {
  cleanup();
  db.ref('queue/' + UID).remove();
  show('screen-menu');
};

document.getElementById('btn-again').onclick = () => {
  show('screen-queue');
  joinQueue();
};

document.getElementById('btn-menu').onclick = () => show('screen-menu');

canvas.addEventListener('touchstart', e => { e.preventDefault(); onTap(); }, { passive: false });
canvas.addEventListener('click', onTap);

window.addEventListener('resize', () => {
  if (document.getElementById('screen-game').classList.contains('active')) resizeCanvas();
});
