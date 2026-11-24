'use strict';

/* Presenter — passive fullscreen output.
   Renders only public game state. Question texts, submitted answers
   and correct answers are never displayed here. */

const socket = io();
const stage = $('stage');

const V = {
  state: 'LOBBY',
  pin: '····',
  joinUrl: '',
  qrSvg: '',
  bankName: 'LOCAL BROADCAST',
  players: [],
  q: null,
  answered: { answered: 0, total: 0 },
  reveal: null,
  lb: null,
  podium: null,
  phase: 'active',
  phaseRemainingMs: null,
  lastWhole: null
};

const ASCII_CELLS = 30;

const countdown = createCountdown(({ whole, fraction, low }) => {
  const num = $('t-num');

  if (num) {
    num.textContent = pad(whole, 3);
    num.classList.toggle('low', low);
  }

  const ascii = $('t-ascii');

  if (ascii) {
    const filled = Math.round(fraction * ASCII_CELLS);
    ascii.textContent =
      '█'.repeat(filled) +
      '░'.repeat(ASCII_CELLS - filled);
  }

  if (whole !== V.lastWhole) {
    V.lastWhole = whole;

    if (low && whole > 0) {
      SFX.play('tick');
    }
  }
});

// ---- countdown helpers ----

function stopCountdown() {
  countdown.stop();
  V.lastWhole = null;
}

function startPhaseCountdown(payload = {}) {
  const remainingMs = Number(payload.remainingMs);

  if (
    Number.isFinite(remainingMs) &&
    remainingMs >= 0
  ) {
    countdown.start(remainingMs / 1000, 0);
    return;
  }

  const timeLimit = Number(
    payload.timeLimit ??
    payload.phaseTimeLimit ??
    V.q?.phaseTimeLimit ??
    V.q?.timeLimit ??
    0
  );

  const elapsedMs = Number(
    payload.phaseElapsedMs ??
    (
      Number(payload.subQuestion || V.q?.subQuestion || 1) === 1
        ? payload.elapsedMs || 0
        : 0
    )
  );

  if (timeLimit > 0) {
    countdown.start(timeLimit, elapsedMs);
  }
}

function applyPhase(payload = {}) {
  V.phase = payload.phase || V.phase || 'active';

  if (payload.subQuestion != null && V.q) {
    V.q.subQuestion = payload.subQuestion;
  }

  if (payload.timeLimit != null && V.q) {
    V.q.phaseTimeLimit = payload.timeLimit;
  }

  if (payload.remainingMs != null) {
    V.phaseRemainingMs = payload.remainingMs;
  } else {
    V.phaseRemainingMs = null;
  }

  if (V.phase === 'paused') {
    stopCountdown();
  } else {
    startPhaseCountdown(payload);
  }

  render();
}

// ---- server events ----

socket.on('connect', () => {
  socket.emit('present:hello');
});

socket.on('present:sync', snap => {
  V.state = snap.state;
  V.pin = snap.pin;

  if (snap.joinUrl) V.joinUrl = snap.joinUrl;
  if (snap.qrSvg) V.qrSvg = snap.qrSvg;

  V.players = snap.players || [];

  if (snap.bankName) {
    V.bankName = snap.bankName;
  }

  SFX.setEnabled(!!snap.sound);
  applyAccent(snap.accent);

  if (snap.answered) {
    V.answered = snap.answered;
  }

  if (snap.reveal) {
    V.reveal = snap.reveal;
  }

  if (snap.leaderboard) {
    V.lb = snap.leaderboard;
  }

  if (snap.podium) {
    V.podium = snap.podium;
  }

  if (snap.question) {
    V.q = snap.question;
    V.phase = snap.question.phase || 'active';
  }

  render();

  if (
    snap.question &&
    snap.state === 'QUESTION_ACTIVE'
  ) {
    if (V.phase === 'paused') {
      stopCountdown();
    } else {
      startPhaseCountdown(snap.question);
    }
  } else {
    stopCountdown();
  }
});

socket.on('playerList', players => {
  const grew = players.length > V.players.length;

  V.players = players;

  if (V.state !== 'LOBBY') return;

  updateLobbyPlayers(grew);

  if (grew) {
    SFX.play('join');
  }
});

socket.on('questionStart', payload => {
  V.state = 'QUESTION_ACTIVE';
  V.q = payload;
  V.phase = payload.phase || 'active';
  V.phaseRemainingMs = payload.remainingMs ?? null;
  V.answered = {
    answered: 0,
    total: V.answered.total
  };

  V.lastWhole = null;

  render();

  if (V.phase === 'paused') {
    stopCountdown();
  } else {
    startPhaseCountdown(payload);
  }

  SFX.play('qstart');
});

socket.on('freeAnswerPhase', payload => {
  if (V.state !== 'QUESTION_ACTIVE') return;

  applyPhase(payload);
});

socket.on('answeredCount', data => {
  const grew = data.answered > V.answered.answered;

  V.answered = data;

  const el = $('t-answered');

  if (el) {
    el.textContent = `${data.answered}/${data.total}`;
  }

  if (grew && V.state === 'QUESTION_ACTIVE') {
    SFX.play('blip');
  }
});

socket.on('questionEnd', data => {
  stopCountdown();

  V.state = 'REVEAL';
  V.reveal = data;
  V.phase = null;

  render();
  SFX.play('reveal');
});

socket.on('leaderboard', data => {
  V.state = 'LEADERBOARD';
  V.lb = data;

  render();
  SFX.play('lb');
});

socket.on('gameOver', data => {
  stopCountdown();

  V.state = 'PODIUM';
  V.podium = data;

  render();
  SFX.play('fanfare');
});

socket.on('stateChange', data => {
  if (data.state !== 'LOBBY') return;

  stopCountdown();

  V.state = 'LOBBY';
  V.q = null;
  V.reveal = null;
  V.phase = 'active';
  V.phaseRemainingMs = null;

  render();
});

socket.on('settingsChanged', data => {
  if (data.sound != null) {
    SFX.setEnabled(!!data.sound);
  }

  if (data.accent) {
    applyAccent(data.accent);
  }

  if (data.bankName && data.bankName !== V.bankName) {
    V.bankName = data.bankName;

    if (V.state === 'LOBBY') {
      render();
    }
  }
});

// ---- renderers ----

const RENDERERS = {
  LOBBY: renderLobby,
  QUESTION_ACTIVE: renderActive,
  REVEAL: renderReveal,
  LEADERBOARD: renderLeaderboard,
  PODIUM: renderPodium
};

function render() {
  const renderer = RENDERERS[V.state];

  if (renderer) {
    renderer();
  }
}

// ---- lobby ----

const CHIP_LIMIT = 40;

function playersLabel() {
  return plural(V.players.length, 'PLAYER') + ' READY';
}

function chipNames() {
  const names = V.players.map(player => player.nickname);

  return names.length > CHIP_LIMIT
    ? names.slice(0, CHIP_LIMIT).concat([
        `+${names.length - CHIP_LIMIT} MORE`
      ])
    : names;
}

function renderLobby() {
  stage.innerHTML = `
    <div class="pad-lobby">
      <div class="hrow">
        <span class="h-brand">TRIVIA//${esc(V.bankName)}</span>
      </div>

      <div class="lobby-mid">
        <div class="lobby-left">
          <div class="lobby-logo">TRIVIA</div>

          <div class="lobby-join">
            JOIN AT
            <span class="lobby-url">${esc(V.joinUrl)}</span>
          </div>

          <div class="lobby-pinrow">
            <span class="lobby-pinlabel">PIN</span>
            <span class="lobby-pin">${esc(V.pin)}</span>
          </div>
        </div>

        <div class="qr-col">
          ${
            V.qrSvg
              ? `<div class="qr-img" role="img" aria-label="QR code to join">${V.qrSvg}</div>`
              : ''
          }

          <span class="qr-cap">SCAN TO JOIN</span>
        </div>
      </div>

      <div class="lobby-foot">
        <div class="lobby-count">
          <span id="p-count">${playersLabel()}</span>
          <span class="blink">_</span>
        </div>

        <div class="chips" id="chips"></div>
      </div>
    </div>
  `;

  updateLobbyPlayers(false);
}

function updateLobbyPlayers(grew) {
  const count = $('p-count');
  const chips = $('chips');

  if (!count || !chips) return;

  count.textContent = playersLabel();

  const names = chipNames();

  const canAppend =
    grew &&
    chips.children.length &&
    names.length >= chips.children.length;

  if (!canAppend) {
    chips.innerHTML = names
      .map(name =>
        `<span class="chip${grew ? ' pop' : ''}">${esc(name)}</span>`
      )
      .join('');

    return;
  }

  // Append only the new chips so the pop-in animation plays once per joiner.
  for (let i = chips.children.length; i < names.length; i++) {
    const element = document.createElement('span');

    element.className = 'chip pop';
    element.textContent = names[i];

    chips.appendChild(element);
  }

  // Refresh the "+N MORE" tail if necessary.
  const last = chips.lastChild;

  if (
    last &&
    names[chips.children.length - 1] !== last.textContent
  ) {
    last.textContent = names[names.length - 1];
  }
}

// ---- question header and phase labels ----

function questionTypeLabel(type) {
  switch (type) {
    case 'duplet':
      return 'DUPLET';

    case 'blitz':
      return 'BLITZ';

    case 'normal':
    default:
      return 'NORMAL';
  }
}

function phaseLabel(phase) {
  switch (phase) {
    case 'paused':
      return 'PAUSED';

    case 'recording':
      return 'RECORDING';

    case 'active':
    default:
      return 'LIVE';
  }
}

function phaseHint(phase) {
  switch (phase) {
    case 'paused':
      return 'WAIT FOR THE OPERATOR';

    case 'recording':
      return 'FINAL ANSWER · CHANGES ARE STILL ACCEPTED';

    case 'active':
    default:
      return 'SUBMIT YOUR ANSWERS';
  }
}

function headerRow(mode) {
  const q = V.q || {};

  const number = q.qNum || '—';
  const total = q.total || '—';

  const left = mode === 'reveal'
    ? `Q.${number}/${total} · RESULTS`
    : `Q.${number}/${total}`;

  const right = mode === 'active'
    ? `<span class="h-live">${phaseLabel(V.phase)}</span>`
    : '';

  const roundInfo = q.roundNumber != null
    ? `ROUND ${q.roundNumber}`
    : questionTypeLabel(q.type);

  return `
    <div class="hrow">
      <span class="h-q">${left}</span>
      <span class="h-cat">${esc(roundInfo)}</span>
      ${right}
    </div>

    <div class="rule"></div>
  `;
}

// ---- active question ----

function currentTimeDisplay() {
  if (
    V.phase === 'paused' &&
    V.phaseRemainingMs != null
  ) {
    return pad(
      Math.ceil(Math.max(0, V.phaseRemainingMs) / 1000),
      3
    );
  }

  const q = V.q || {};

  return pad(
    Math.ceil(
      Number(
        q.phaseTimeLimit ??
        q.timeLimit ??
        0
      )
    ),
    3
  );
}

function renderActive() {
  const q = V.q || {};

  const type = questionTypeLabel(q.type);

  const subQuestion = Number(
    q.subQuestion || 1
  );

  const subQuestionCount = {
    normal: 1,
    duplet: 2,
    blitz: 3
  }[q.type] || 1;

  const isPaused = V.phase === 'paused';
  const isRecording = V.phase === 'recording';

  const phaseStyle = isPaused
    ? 'color:#ffb347;border-color:#ffb347;'
    : isRecording
      ? 'color:#55e6ff;border-color:#55e6ff;'
      : '';

  const phaseText = isPaused
    ? 'PAUSED'
    : isRecording
      ? 'RECORDING'
      : 'LIVE';

  const subQuestionText = subQuestionCount > 1
    ? `PART ${subQuestion}/${subQuestionCount}`
    : 'ONE ANSWER';

  stage.innerHTML = `
    <div class="pad">
      ${headerRow('active')}

      <div class="q-mid" style="
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:2.5cqw;
        text-align:center;
      ">
        <div style="
          font-size:2.1cqw;
          letter-spacing:.18em;
          opacity:.65;
        ">
          FREE ANSWER
        </div>

        <div style="
          font-size:5.2cqw;
          font-weight:800;
          letter-spacing:.08em;
        ">
          ${esc(type)}
        </div>

        <div style="
          font-size:2.4cqw;
          letter-spacing:.12em;
          opacity:.8;
        ">
          ${esc(subQuestionText)}
        </div>

        <div style="
          font-size:2cqw;
          letter-spacing:.1em;
          padding:.6cqw 1.5cqw;
          border:1px solid currentColor;
          ${phaseStyle}
        ">
          ${phaseText}
        </div>
      </div>

      <div class="t-row">
        <div class="t-nums">
          <span class="t-big" id="t-num">${currentTimeDisplay()}</span>
          <span class="t-sec">SEC</span>
        </div>

        <div class="t-ascii" id="t-ascii">
          ${'█'.repeat(ASCII_CELLS)}
        </div>

        <div class="t-count">
          <span id="t-answered">
            ${V.answered.answered}/${V.answered.total}
          </span>
          ANSWERED
          <span class="blink">█</span>
        </div>
      </div>

      <div style="
        text-align:center;
        font-size:1.5cqw;
        letter-spacing:.12em;
        opacity:.65;
        margin-top:1.5cqw;
      ">
        ${esc(phaseHint(V.phase))}
      </div>
    </div>
  `;

  if (isPaused) {
    const num = $('t-num');

    if (num) {
      num.classList.remove('low');
    }
  }

  if (isRecording) {
    const num = $('t-num');

    if (num) {
      num.classList.add('low');
    }
  }
}

// ---- reveal ----

function renderReveal() {
  const q = V.q || {};
  const answered = V.answered || {
    answered: 0,
    total: 0
  };

  stage.innerHTML = `
    <div class="pad">
      ${headerRow('reveal')}

      <div class="q-mid" style="
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        text-align:center;
        gap:3cqw;
      ">
        <div style="
          font-size:4.2cqw;
          font-weight:800;
          letter-spacing:.12em;
        ">
          ANSWERS LOCKED
        </div>

        <div style="
          font-size:2.5cqw;
          opacity:.8;
        ">
          ${answered.answered} / ${answered.total} ANSWERS SUBMITTED
        </div>

        <div style="
          font-size:2cqw;
          letter-spacing:.12em;
          opacity:.65;
        ">
          OPERATOR IS GRADING
        </div>
      </div>

      <div class="foot-hint">
        OPERATOR ▸ SHOW LEADERBOARD
      </div>
    </div>
  `;
}

// ---- leaderboard / podium ----

function rankDelta(delta) {
  if (delta == null || delta === 0) {
    return {
      text: '—',
      cls: 'flat'
    };
  }

  return delta > 0
    ? {
        text: `▲${delta}`,
        cls: 'up'
      }
    : {
        text: `▼${-delta}`,
        cls: 'down'
      };
}

const LB_ROWS = 8;

function renderLeaderboard() {
  const lb = V.lb;

  if (!lb || !Array.isArray(lb.standings)) {
    stage.innerHTML = `
      <div class="pad">
        <div class="hrow">
          <span class="lb-title">STANDINGS</span>
        </div>
      </div>
    `;

    return;
  }

  const rows = lb.standings
    .slice(0, LB_ROWS)
    .map(row => {
      const delta = rankDelta(row.delta);

      return `
        <div class="lb-row${row.rank === 1 ? ' first' : ''}">
          <span class="lb-rank">${pad(row.rank)}</span>
          <span class="lb-name">${esc(row.nickname)}</span>
          <span class="lb-delta ${delta.cls}">${delta.text}</span>
          <span class="lb-score">${fmt(row.score)}</span>
        </div>
      `;
    })
    .join('');

  stage.innerHTML = `
    <div class="pad tight">
      <div class="hrow">
        <span class="lb-title">
          STANDINGS · AFTER Q.${lb.afterQuestion}
        </span>

        <span class="h-cat">
          ${lb.totalQuestions} QUESTIONS TOTAL
        </span>
      </div>

      <div class="rule"></div>
      <div class="lb-list">${rows}</div>

      <div class="foot-hint">
        OPERATOR ▸ NEXT QUESTION
      </div>
    </div>
  `;
}

// Pedestal styling for 1st / 2nd / 3rd.
const PODIUM_STEPS = {
  1: {
    col: '#ffb347',
    rgb: '255,179,71',
    height: 17,
    label: '1ST'
  },

  2: {
    col: '#56ff8a',
    rgb: '86,255,138',
    height: 12,
    label: '2ND'
  },

  3: {
    col: '#55e6ff',
    rgb: '85,230,255',
    height: 9,
    label: '3RD'
  }
};

const FINAL_ROWS = 12;

function podiumColumn(player) {
  const step = PODIUM_STEPS[
    Math.min(3, player.rank)
  ];

  if (!step) return '';

  const block =
    `height:${step.height}cqw;` +
    `border:1px solid ${step.col};` +
    `background:rgba(${step.rgb},.1);` +
    `box-shadow:0 0 1.2cqw rgba(${step.rgb},.35);` +
    `color:${step.col}`;

  return `
    <div class="pod-col">
      <div class="pod-name">${esc(player.nickname)}</div>
      <div class="pod-score">${fmt(player.score)} PTS</div>
      <div class="pod-block" style="${block}">
        ${step.label}
      </div>
    </div>
  `;
}

function renderPodium() {
  const data = V.podium || {};
  const podium = data.podium || [];
  const standings = data.standings || [];

  const byRank = rank =>
    podium.find(player => player.rank === rank) ||
    podium[rank - 1];

  // 2nd on the left, 1st in the middle, 3rd on the right.
  const cols = [
    byRank(2),
    byRank(1),
    byRank(3)
  ]
    .filter(Boolean)
    .map(podiumColumn)
    .join('');

  const finals = standings
    .slice(0, FINAL_ROWS)
    .map(player => `
      <div class="final-row">
        <span class="final-rank">${pad(player.rank)}</span>
        <span class="final-name">${esc(player.nickname)}</span>
        <span>${fmt(player.score)}</span>
      </div>
    `)
    .join('');

  stage.innerHTML = `
    <div class="pad flush">
      <div class="pod-title">★ FINAL RESULTS ★</div>
      <div class="pod-row">${cols}</div>
      <div class="final-grid">${finals}</div>
    </div>
  `;
}