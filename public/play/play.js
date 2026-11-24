'use strict';

/* Player phone client — thin: renders whatever the server broadcasts.
   Stores only its session token + nickname draft (reconnect restores state). */

const socket = io();

const SCREENS = [
  's-join',
  's-lobby',
  's-wait',
  's-question',
  's-result',
  's-rank',
  's-final'
];

function show(id) {
  SCREENS.forEach(s => {
    $(s).hidden = s !== id;
  });
}

const store = {
  get token() {
    return localStorage.getItem('trivia_token') || '';
  },

  set token(v) {
    v
      ? localStorage.setItem('trivia_token', v)
      : localStorage.removeItem('trivia_token');
  },

  get nickDraft() {
    return localStorage.getItem('trivia_nick') || '';
  },

  set nickDraft(v) {
    localStorage.setItem('trivia_nick', v);
  },

  get agreed() {
    return localStorage.getItem('trivia_terms') === '1';
  },

  set agreed(v) {
    v
      ? localStorage.setItem('trivia_terms', '1')
      : localStorage.removeItem('trivia_terms');
  },

  get device() {
    let id = localStorage.getItem('trivia_device');

    if (!id) {
      id = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        b => b.toString(16).padStart(2, '0')
      ).join('');

      localStorage.setItem('trivia_device', id);
    }

    return id;
  }
};

const REPORT_ADDRESS = 'report@local-trivia.com';

let me = {
  nickname: '',
  score: 0,
  rank: null
};

let eligibleFrom = 0;
let question = null;

let freeAnswerLocked = false;
let freeAnswerRecording = false;
let freeAnswerPaused = false;
let freeAnswerDraft = '';

let draftSyncTimer = null;

const countdown = createCountdown(({ whole, fraction, low }) => {
  $('q-timer').textContent = 'T-' + pad(whole, 3);
  $('q-timer').classList.toggle('low', low);

  $('q-warning').hidden =
    !low ||
    !question ||
    freeAnswerRecording ||
    freeAnswerPaused;

  const fill = $('q-bar-fill');

  fill.style.width = (100 * fraction).toFixed(1) + '%';
  fill.classList.toggle('low', low);
});

// ---- free answer helpers ----

function cancelDraftSync() {
  if (draftSyncTimer !== null) {
    clearTimeout(draftSyncTimer);
    draftSyncTimer = null;
  }
}

function canEditFreeAnswer() {
  return (
    !!question &&
    !freeAnswerLocked &&
    !freeAnswerPaused &&
    (
      !freeAnswerRecording ||
      freeAnswerRecording
    )
  );
}

// Send the current textarea contents to the server as a draft.
// This does not submit or lock the answer.
function syncFreeAnswerDraft() {
  cancelDraftSync();

  if (!canEditFreeAnswer()) return;

  const input = $('q-answer');

  if (!input) return;

  freeAnswerDraft = input.value;

  socket.emit('updateFreeAnswerDraft', {
    answer: freeAnswerDraft
  });
}

function scheduleDraftSync() {
  if (!canEditFreeAnswer()) return;

  cancelDraftSync();

  // Debounce draft updates to avoid emitting on every keystroke.
  draftSyncTimer = setTimeout(() => {
    draftSyncTimer = null;
    syncFreeAnswerDraft();
  }, 200);
}

function resetFreeAnswerState() {
  cancelDraftSync();

  freeAnswerLocked = false;
  freeAnswerRecording = false;
  freeAnswerPaused = false;
  freeAnswerDraft = '';
}

function phaseFromSnapshot(snap) {
  return (
    snap.question?.phase ||
    snap.freeAnswerPhase ||
    'active'
  );
}

function startQuestionCountdown(payload = {}) {
  if (payload.phase === 'paused') {
    countdown.stop();
    return;
  }

  const remainingMs =
  payload.remainingMs == null
    ? NaN
    : Number(payload.remainingMs);

  if (
    Number.isFinite(remainingMs) &&
    remainingMs >= 0
  ) {
    countdown.start(remainingMs / 1000, 0);
    return;
  }

  const timeLimit = Number(
    payload.phaseTimeLimit ??
    payload.timeLimit ??
    question?.phaseTimeLimit ??
    question?.timeLimit ??
    60
  );

  const elapsedMs = Number(payload.elapsedMs || 0);

  countdown.start(timeLimit, elapsedMs);
}

// ---- stored nickname ----

$('in-nick').value = store.nickDraft;

$('in-nick').addEventListener('input', e => {
  store.nickDraft = e.target.value;
});

// A phone-hosted game's QR code links here with its PIN (?pin=4821).
const linkedPin = new URLSearchParams(location.search).get('pin');

if (linkedPin && /^\d{4,6}$/.test(linkedPin)) {
  $('in-pin').value = linkedPin;
  $('join-foot').hidden = true;
}

// ---- join ----

$('in-agree').checked = store.agreed;
$('btn-join').disabled = !store.agreed;

$('in-agree').addEventListener('change', e => {
  store.agreed = e.target.checked;
  $('btn-join').disabled = !e.target.checked;
});

$('btn-join').addEventListener('click', () => {
  if (!store.agreed) return;

  $('join-err').hidden = true;

  socket.emit('join', {
    pin: $('in-pin').value.trim(),
    nickname: $('in-nick').value.trim(),
    device: store.device
  });
});

[$('in-pin'), $('in-nick')].forEach(el => {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      $('btn-join').click();
    }
  });
});

// ---- report ----

function report(kind) {
  const lines = [
    'Local Trivia report (browser player)',
    ''
  ];

  if (kind === 'question' && question) {
    lines.push('Reported: a question');
    lines.push('Round: ' + (question.roundNumber ?? '-'));
    lines.push('Question: ' + (question.questionNumber ?? '-'));
  } else {
    lines.push('Reported: a game and its host');
  }

  lines.push(
    'Game: ' + location.host,
    'Player: ' + (me.nickname || '-'),
    'Reason: ',
    'Details: ',
    '',
    'Sent: ' + new Date().toISOString()
  );

  const subject = kind === 'question'
    ? 'Local Trivia report: question'
    : 'Local Trivia report: game host';

  location.href =
    'mailto:' + REPORT_ADDRESS +
    '?subject=' + encodeURIComponent(subject) +
    '&body=' + encodeURIComponent(lines.join('\n'));
}

document.querySelectorAll('[data-report]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    report(link.dataset.report);
  });
});

// ---- socket connection ----

socket.on('joinError', err => {
  if (!err || !err.message) return;

  $('join-err').textContent = err.message;
  $('join-err').hidden = false;
});

socket.on('joined', snap => {
  store.token = snap.token;
  $('kicked-msg').hidden = true;
  applySnapshot(snap);
});

socket.on('connect', () => {
  $('link-lost').hidden = true;

  if (store.token) {
    socket.emit('resume', {
      token: store.token
    });
  }
});

socket.on('disconnect', reason => {
  if (reason !== 'io server disconnect') {
    $('link-lost').hidden = false;
  }

  // Do not keep a stale debounce timer across a disconnect.
  cancelDraftSync();
});

socket.on('resumed', snap => {
  applySnapshot(snap);
});

socket.on('resumeFailed', () => {
  store.token = '';
  countdown.stop();
  question = null;
  resetFreeAnswerState();
  show('s-join');
});

socket.on('kicked', data => {
  store.token = '';
  countdown.stop();
  question = null;
  resetFreeAnswerState();

  $('kicked-msg').textContent =
    (data && data.message) || 'REMOVED BY OPERATOR';

  $('kicked-msg').hidden = false;
  show('s-join');
});

// ---- snapshots ----

function applySnapshot(snap) {
  me = {
    nickname: snap.nickname,
    score: snap.score || 0,
    rank: snap.rank || null
  };

  eligibleFrom = snap.eligibleFrom || 0;

  if (snap.sound != null) {
    SFX.setEnabled(!!snap.sound);
  }

  if (snap.accent) {
    applyAccent(snap.accent);
  }

  switch (snap.state) {
    case 'LOBBY':
      question = null;
      resetFreeAnswerState();
      countdown.stop();
      renderLobby(snap.playerCount || 0);
      break;

    case 'QUESTION_ACTIVE':
      if (!snap.question) {
        show('s-wait');
        return;
      }

      question = snap.question;

      freeAnswerLocked = !!snap.freeAnswer?.locked;
      freeAnswerDraft = snap.freeAnswer?.answer ?? '';

      const phase = phaseFromSnapshot(snap);

      freeAnswerRecording = phase === 'recording';
      freeAnswerPaused = phase === 'paused';

      question.phase = phase;

      renderQuestion(snap.question);
      break;

    case 'REVEAL':
      countdown.stop();
      resetFreeAnswerState();

      if (snap.lastResult) {
        renderResult(snap.lastResult);
      } else {
        show('s-wait');
      }
      break;

    case 'LEADERBOARD':
      countdown.stop();
      resetFreeAnswerState();
      renderRank(me.rank, me.score);
      break;

    case 'PODIUM':
      countdown.stop();
      resetFreeAnswerState();
      renderFinal(me.rank, me.score);
      break;
  }
}

// ---- lobby ----

function renderLobby(count) {
  $('lb-name').textContent = me.nickname;
  $('lb-count').textContent = plural(count, 'PLAYER') + ' READY';

  show('s-lobby');
}

socket.on('playerCount', d => {
  if (!$('s-lobby').hidden) {
    $('lb-count').textContent =
      plural(d.count, 'PLAYER') + ' READY';
  }
});

socket.on('stateChange', d => {
  if (d.state === 'LOBBY' && store.token) {
    question = null;
    resetFreeAnswerState();

    countdown.stop();
    renderLobby(0);

    socket.emit('resume', {
      token: store.token
    });
  }
});

// ---- free answer question ----

socket.on('questionStart', payload => {
  if (!store.token) return;

  if (eligibleFrom > payload.index) {
    show('s-wait');
    return;
  }

  question = payload;

  resetFreeAnswerState();

  question.phase = payload.phase || 'active';

  renderQuestion(payload);
});

function renderQuestion(payload = {}) {
  if (!question) return;

  $('q-nick').textContent = me.nickname;

  $('q-text').textContent =
    `Тур ${question.roundNumber} · Вопрос ${question.questionNumber}`;

  $('q-text').className = 'q-text len-s';

  $('q-phase').hidden = true;
  $('q-warning').hidden = true;

  const input = $('q-answer');
  const button = $('btn-submit-answer');

  input.value = freeAnswerDraft;

  input.oninput = () => {
    freeAnswerDraft = input.value;
    scheduleDraftSync();
  };

  // Save the latest text immediately when the player leaves the field.
  input.onblur = () => {
    syncFreeAnswerDraft();
  };

  button.onclick = submitFreeAnswer;

  updateFreeAnswerUI();

  show('s-question');

  if (freeAnswerPaused) {
    countdown.stop();
  } else {
    startQuestionCountdown(payload);
  }
}

function submitFreeAnswer() {
  if (
    !question ||
    freeAnswerPaused ||
    freeAnswerLocked ||
    freeAnswerRecording
  ) {
    return;
  }

  cancelDraftSync();

  const input = $('q-answer');

  if (!input) return;

  freeAnswerDraft = input.value;

  socket.emit('submitFreeAnswer', {
    answer: freeAnswerDraft
  });

  freeAnswerLocked = true;

  SFX.play('blip');

  updateFreeAnswerUI();
}

function updateFreeAnswerUI() {
  const input = $('q-answer');
  const button = $('btn-submit-answer');

  if (!input || !button) return;

  const phaseLabel = $('q-phase');
  const status = $('q-status');

  if (freeAnswerPaused) {
    input.disabled = true;
    button.disabled = true;

    phaseLabel.hidden = false;
    status.textContent = 'ПАУЗА';

    $('q-warning').hidden = true;
    return;
  }

  if (freeAnswerRecording) {
    phaseLabel.hidden = false;

    if (freeAnswerLocked) {
      input.disabled = true;
      button.disabled = true;

      status.textContent = 'ОТВЕТ ЗАФИКСИРОВАН';
    } else {
      input.disabled = false;
      button.disabled = true;

      status.textContent = 'ЗАПИСЬ ОТВЕТА';
    }

    $('q-warning').hidden = true;
    return;
  }

  phaseLabel.hidden = true;

  if (freeAnswerLocked) {
    input.disabled = true;
    button.disabled = true;

    status.textContent = 'ОТВЕТ ЗАФИКСИРОВАН';
    return;
  }

  input.disabled = false;
  button.disabled = false;

  status.textContent = 'ВВЕДИТЕ ОТВЕТ';
}

// ---- free answer phases ----

socket.on('freeAnswerPhase', payload => {
  if (!question || !payload) return;

  if (payload.phase === 'paused') {
    cancelDraftSync();

    freeAnswerPaused = true;
    freeAnswerRecording = false;

    question.phase = 'paused';

    countdown.stop();
    updateFreeAnswerUI();

    return;
  }

  if (payload.phase === 'active') {
    cancelDraftSync();

    freeAnswerPaused = false;
    freeAnswerRecording = false;

    question.phase = 'active';

    if (payload.subQuestion != null) {
      question.subQuestion = payload.subQuestion;
    }

    if (payload.timeLimit != null) {
      question.phaseTimeLimit = payload.timeLimit;
    }

    if (payload.phaseTimeLimit != null) {
      question.phaseTimeLimit = payload.phaseTimeLimit;
    }

    updateFreeAnswerUI();
    startQuestionCountdown(payload);

    return;
  }

  if (payload.phase === 'recording') {
    cancelDraftSync();

    freeAnswerPaused = false;
    freeAnswerRecording = true;

    // Do not unlock an answer that was already submitted.
    // Only players without a submitted answer may edit their draft.
    question.phase = 'recording';

    updateFreeAnswerUI();

    startQuestionCountdown({
      ...payload,
      timeLimit: payload.timeLimit ?? 10
    });
  }
});

// The server confirms that the submitted answer was received.
socket.on('answerAck', payload => {
  if (freeAnswerLocked) {
    $('q-status').textContent = 'ОТВЕТ ЗАФИКСИРОВАН';
  } else if (freeAnswerRecording) {
    $('q-status').textContent = 'ЗАПИСЬ ОТВЕТА';
  }
});

socket.on('questionEnd', () => {
  cancelDraftSync();
  countdown.stop();

  $('q-answer').disabled = true;
  $('btn-submit-answer').disabled = true;
  $('q-warning').hidden = true;
});

// ---- reveal / leaderboard / podium ----

socket.on('personalResult', r => {
  me.score = r.totalScore;
  me.rank = r.rank;

  renderResult(r);
});

function renderResult(r) {
  const title = $('r-title');

  title.textContent = 'ОТВЕТ ПРИНЯТ';
  title.className = 'r-title ok';

  $('r-pts').textContent = `+${fmt(r.points)} PTS`;
  $('r-total').textContent = `TOTAL ${fmt(r.totalScore)} PTS`;
  $('r-rank').textContent = `RANK #${r.rank || '—'}`;

  show('s-result');
}

socket.on('personalRank', d => {
  me.rank = d.rank;
  me.score = d.score;

  if (d.phase === 'podium') {
    renderFinal(d.rank, d.score);
  } else {
    renderRank(d.rank, d.score);
  }
});

function renderRank(rank, score) {
  $('k-rank').textContent = '#' + (rank || '—');
  $('k-score').textContent = `${fmt(score)} PTS`;

  show('s-rank');
}

function renderFinal(rank, score) {
  $('f-rank').textContent = '#' + (rank || '—');
  $('f-name').textContent = me.nickname;
  $('f-score').textContent = `${fmt(score)} PTS`;

  show('s-final');
}

socket.on('gameOver', () => {
  if (store.token && $('s-final').hidden) {
    renderFinal(me.rank, me.score);
  }
});

// ---- presentation settings ----

socket.on('settingsChanged', d => {
  if (d.sound != null) {
    SFX.setEnabled(!!d.sound);
  }

  if (d.accent) {
    applyAccent(d.accent);
  }
});