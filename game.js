// ── CONSTANTS ──────────────────────────────────────────────────────────────
const BH     = 34;
const MIN_W  = 10;
const COLORS = ['#FF6B6B','#FF922B','#FFD43B','#69DB7C','#4DABF7','#748FFC','#DA77F2','#F783AC','#63E6BE','#FFA94D'];

// ── FIREBASE INIT ──────────────────────────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const db   = firebase.database();
const auth = firebase.auth();

// ── APP STATE ──────────────────────────────────────────────────────────────
let currentUser = null;
let myName = '', oppName = '', oppScore = 0;
let mySlot = '', gameId = '', gRef = null;

// ── GAME STATE ─────────────────────────────────────────────────────────────
let blocks = [], score = 0, gameOver = false, rafId = null;
let curX = 0, curW = 0, curDir = 1, curSpeed = 2.5;
let camY = 0, tapHintShown = true;
let CW = 0, CH = 0;

const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

// ── SCREENS ────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function resizeCanvas() {
  CW = canvas.offsetWidth;
  CH = canvas.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = CW * dpr;
  canvas.height = CH * dpr;
  ctx.scale(dpr, dpr);
}

// ── AUTH ───────────────────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (!user) { show('screen-auth'); return; }
  setupMenu(user);
  show('screen-menu');
});

function setupMenu(user) {
  const isGoogle  = user.providerData.some(p => p.providerId === 'google.com');
  const avatar    = document.getElementById('user-avatar');
  const hudAvatar = document.getElementById('hud-avatar');
  const display   = document.getElementById('user-display');
  const nickRow   = document.getElementById('nickname-row');
  const nameInput = document.getElementById('player-name');

  if (isGoogle && user.displayName) {
    myName = user.displayName;
    display.textContent = user.displayName;
    document.getElementById('user-label').textContent = 'Signed in as';

    if (user.photoURL) {
      avatar.src    = user.photoURL;
      hudAvatar.src = user.photoURL;
      avatar.style.display    = 'block';
      hudAvatar.style.display = 'block';
    }
    nickRow.style.display = 'none';
  } else {
    // Anonymous / guest
    display.textContent = 'Guest';
    document.getElementById('user-label').textContent = 'Playing as';
    avatar.style.display    = 'none';
    hudAvatar.style.display = 'none';
    nickRow.style.display   = 'block';
    myName = nameInput.value.trim() || '';
  }
}

document.getElementById('btn-google').onclick = async () => {
  const err = document.getElementById('auth-error');
  err.textContent = '';
  try {
    await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (e) {
    err.textContent = e.code === 'auth/popup-closed-by-user'
      ? 'Sign-in cancelled.'
      : 'Sign-in failed. Try again.';
  }
};

document.getElementById('btn-anon').onclick = async () => {
  document.getElementById('auth-error').textContent = '';
  try {
    await auth.signInAnonymously();
  } catch (e) {
    document.getElementById('auth-error').textContent = 'Could not connect. Check your connection.';
  }
};

document.getElementById('btn-signout').onclick = () => {
  cleanup();
  auth.signOut();
};

// ── MATCHMAKING ────────────────────────────────────────────────────────────
function joinQueue() {
  cleanup(); // clear any lingering listeners from previous session

  const uid      = currentUser.uid;
  const joinTime = Date.now(); // used to reject stale games
  const qRef     = db.ref('queue/' + uid);
  qRef.set({ name: myName, ts: firebase.database.ServerValue.TIMESTAMP });
  qRef.onDisconnect().remove();

  // Second player creates the game (avoids race conditions)
  db.ref('queue').on('value', async snap => {
    const q = snap.val();
    if (!q) return;
    const sorted = Object.entries(q).sort((a, b) => a[1].ts - b[1].ts);
    if (sorted.length < 2 || sorted[1][0] !== uid) return;

    const [uid1, d1] = sorted[0];
    const [uid2, d2] = sorted[1];
    const gId = db.ref('games').push().key;
    await db.ref().update({
      [`queue/${uid1}`]: null,
      [`queue/${uid2}`]: null,
      [`games/${gId}`]: {
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        p1: { uid: uid1, name: d1.name, score: 0, lost: false },
        p2: { uid: uid2, name: d2.name, score: 0, lost: false }
      }
    });
  });

  // Listen for a game that includes me
  ['p1', 'p2'].forEach(slot => {
    db.ref('games').orderByChild(`${slot}/uid`).equalTo(uid)
      .limitToLast(1).on('child_added', snap => {
        const g = snap.val();

        // Reject stale games: created before I entered the queue (with 10s grace)
        if (g.createdAt && g.createdAt < joinTime - 10000) return;

        // Guard: don't start twice if both p1/p2 listeners fire
        if (gameId) return;

        db.ref('queue').off();
        db.ref('queue/' + uid).remove();

        gameId      = snap.key;
        mySlot      = slot;
        const oSlot = slot === 'p1' ? 'p2' : 'p1';
        oppName     = g[oSlot].name;
        gRef        = db.ref(`games/${gameId}/${mySlot}`);

        document.getElementById('my-name').textContent   = myName;
        document.getElementById('opp-name').textContent  = oppName;
        document.getElementById('opp-score').textContent = '0';
        document.getElementById('tap-hint').style.display = 'block';
        tapHintShown = true;

        show('screen-game');
        // Wait for CSS transition so canvas has real dimensions before init
        setTimeout(() => {
          resizeCanvas();
          initGame();
          watchOpponent(gameId, oSlot);
        }, 80);
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

// ── GAME INIT ──────────────────────────────────────────────────────────────
function initGame() {
  score = 0; blocks = []; camY = 0; gameOver = false;
  document.getElementById('my-score').textContent = '0';

  const baseW = Math.round(CW * 0.68);
  blocks.push({ x: Math.round((CW - baseW) / 2), w: baseW, color: COLORS[0] });
  spawnBlock();

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function spawnBlock() {
  const last = blocks[blocks.length - 1];
  curW   = last.w;
  curX   = 0;
  curDir = 1;
  curSpeed = Math.min(2.5 + score * 0.09, 8);
}

// ── GAME LOOP ──────────────────────────────────────────────────────────────
function loop() {
  if (gameOver) return;
  curX += curDir * curSpeed;
  if (curX < 0 || curX + curW > CW) { curDir *= -1; curX += curDir * curSpeed; }

  // Camera: keep moving block near top-third
  const targetCam = Math.max(0, (blocks.length + 1) * BH - CH * 0.7);
  camY += (targetCam - camY) * 0.07;

  draw();
  rafId = requestAnimationFrame(loop);
}

// ── DRAW ───────────────────────────────────────────────────────────────────
function draw() {
  ctx.fillStyle = '#0d0f1a';
  ctx.fillRect(0, 0, CW, CH);

  // Edge vignette
  ['left', 'right'].forEach(side => {
    const g = ctx.createLinearGradient(
      side === 'left' ? 0 : CW, 0,
      side === 'left' ? 44 : CW - 44, 0
    );
    g.addColorStop(0, 'rgba(13,15,26,0.65)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(side === 'left' ? 0 : CW - 44, 0, 44, CH);
  });

  // Placed blocks
  blocks.forEach((b, i) => {
    const y = CH - (i + 1) * BH - camY;
    if (y > CH + BH || y + BH < -20) return;
    ctx.fillStyle = b.color;
    roundRect(b.x, y, b.w, BH - 3, 6);
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(b.x + 2, y + 2, b.w - 4, 5, 2);
  });

  // Moving block
  const mY = CH - (blocks.length + 1) * BH - camY;
  const ci = blocks.length % COLORS.length;
  ctx.fillStyle = COLORS[ci];
  ctx.globalAlpha = 0.9;
  roundRect(curX, mY, curW, BH - 3, 6);

  // Glow
  ctx.shadowColor = COLORS[ci];
  ctx.shadowBlur  = 20;
  roundRect(curX, mY + BH - 8, curW, 5, 3);
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
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

  if (tapHintShown) {
    document.getElementById('tap-hint').style.display = 'none';
    tapHintShown = false;
  }

  const last    = blocks[blocks.length - 1];
  const left    = Math.max(curX, last.x);
  const right   = Math.min(curX + curW, last.x + last.w);
  const overlap = right - left;

  if (overlap <= MIN_W) { return loseGame(); }

  const isPerfect = Math.abs(left - last.x) < 5 && Math.abs(right - (last.x + last.w)) < 5;
  blocks.push({
    x: isPerfect ? last.x : left,
    w: isPerfect ? last.w : overlap,
    color: COLORS[blocks.length % COLORS.length]
  });

  score++;
  document.getElementById('my-score').textContent = score;
  gRef && gRef.update({ score, lost: false });

  spawnBlock();
  if (navigator.vibrate) navigator.vibrate(isPerfect ? [8, 20, 8] : 12);
}

// ── END GAME ───────────────────────────────────────────────────────────────
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
  if (currentUser) db.ref('queue/' + currentUser.uid).remove();
  if (gameId) {
    db.ref(`games/${gameId}/${mySlot === 'p1' ? 'p2' : 'p1'}`).off();
  }
  ['p1', 'p2'].forEach(s => {
    if (currentUser)
      db.ref('games').orderByChild(`${s}/uid`).equalTo(currentUser.uid).off();
  });
  gameId = ''; gRef = null;
}

// ── UI EVENTS ──────────────────────────────────────────────────────────────
document.getElementById('btn-play').onclick = () => {
  const isAnon = !currentUser || currentUser.isAnonymous;
  if (isAnon) {
    myName = document.getElementById('player-name').value.trim() || 'Guest';
  }
  if (!myName) {
    document.getElementById('player-name').focus();
    return;
  }
  show('screen-queue');
  joinQueue();
};

document.getElementById('btn-cancel').onclick = () => {
  cleanup();
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
