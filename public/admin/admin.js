'use strict';

/*
 * Admin console — free-answer game control.
 *
 * The admin console:
 *   - controls the game session;
 *   - configures rounds and question types;
 *   - monitors connected teams;
 *   - displays answers for every question in the selected round;
 *   - manually grades answers (+1);
 *   - displays cumulative scores;
 *   - controls presentation settings.
 */

const ADMIN_KEY = new URLSearchParams(location.search).get('k') || '';

const socket = ADMIN_KEY
  ? io({ auth: { token: ADMIN_KEY } })
  : io();

let sync = null;
let settings = null;
let freeRounds = [];

let freeRoundsDirty = false;
let freeRoundsInitialized = false;

let timerInterval = null;


/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */


function api(path, options = {}) {
  const opts = Object.assign({}, options);

  if (ADMIN_KEY) {
    opts.headers = Object.assign({}, opts.headers, {
      'x-admin-token': ADMIN_KEY
    });
  }

  return fetch(path, opts).then(async res => ({
    ok: res.ok,
    data: await res.json().catch(() => ({}))
  }));
}


/* -------------------------------------------------------------------------- */
/* SOCKET.IO                                                                  */
/* -------------------------------------------------------------------------- */

socket.on('connect', () => {
  socket.emit('admin:hello');
});


socket.on('adminDenied', d => {
  document.body.innerHTML =
    '<main style="padding:2rem;font-family:monospace;color:var(--c-text,#9effb8);line-height:1.6">' +
    '<h1 style="font-size:1.2rem">ADMIN LOCKED</h1>' +
    '<p>' +
    esc(d && d.message ? d.message : 'NOT AUTHORIZED') +
    '</p>' +
    '<p>Open the console on the computer running the server, or start it with ' +
    'TRIVIA_ADMIN_TOKEN set and load <code>/admin?k=&lt;token&gt;</code>.</p>' +
    '</main>';
});


socket.on('admin:sync', s => {
  sync = s;
  settings = s.settings || {};

  renderSession();
  renderFreeAnswerSetup();
  renderCurrentGame();
  renderTeams();
  renderScoreboard();
  renderRoundResults();
  renderPresentation();
  updateAdminTimer();
});


socket.on('connect_error', err => {
  console.error('[admin] socket connection failed:', err);
});


/* -------------------------------------------------------------------------- */
/* SESSION CONTROL                                                            */
/* -------------------------------------------------------------------------- */

const BADGE_COLORS = {
  QUESTION_ACTIVE: 'var(--c-amber)',
  REVEAL: 'var(--c-amber)',
  LEADERBOARD: 'var(--c-magenta)',
  PODIUM: 'var(--c-magenta)',
  PAUSED: 'var(--c-amber)'
};


function renderSession() {
  if (!sync) return;

  const badge = $('state-badge');

  if (!badge) return;

  let stateText = String(sync.state || 'LOBBY')
    .replaceAll('_', ' ');

  if (sync.state === 'QUESTION_ACTIVE' && sync.freeAnswerPhase) {
    stateText += ' · ' + sync.freeAnswerPhase.toUpperCase();
  }

  badge.textContent = '● ' + stateText;

  const col =
    BADGE_COLORS[sync.state] ||
    'var(--c-green)';

  badge.style.borderColor = col;
  badge.style.color = col;

  $('pin').textContent = sync.pin || '····';

  if (sync.state === 'LOBBY') {
    $('progress').textContent = 'READY';
  } else {
    const qNum = Math.max(1, Number(sync.qNum || 0));
    const qTotal = Math.max(0, Number(sync.qTotal || 0));

    $('progress').textContent =
      qTotal ? `Q ${qNum}/${qTotal}` : 'READY';
  }

  renderOpButtons();
  renderPlayers();
}


/* -------------------------------------------------------------------------- */
/* OPERATOR BUTTONS                                                           */
/* -------------------------------------------------------------------------- */

function opControls(s) {
  if (!s) {
    return {
      buttons: [],
      hint: ''
    };
  }

  switch (s.state) {
    case 'LOBBY': {
      const rounds = s.freeAnswerGame?.rounds || [];
      const contentReady = rounds.length > 0;

      const canStart =
        s.connectedCount > 0 &&
        contentReady;

      return {
        buttons: [{
          label: '▸ START GAME',
          event: 'host:start',
          primary: canStart,
          disabled: !canStart
        }],

        hint:
          `${rounds.length} ROUNDS · FREE ANSWER` +
          (s.connectedCount
            ? ` · ${s.connectedCount} TEAM${s.connectedCount === 1 ? '' : 'S'}`
            : ' · WAITING FOR TEAMS')
      };
    }

    case 'QUESTION_ACTIVE': {
      const buttons = [];

      if (s.freeAnswerPhase === 'paused') {
        buttons.push({
          label: '▶ RESUME',
          event: 'host:freeAnswerResume',
          primary: true
        });
      } else if (s.freeAnswerPhase === 'active') {
        buttons.push({
          label: 'Ⅱ PAUSE',
          event: 'host:freeAnswerPause'
        });
      } else if (s.freeAnswerPhase === 'recording') {
        buttons.push({
          label: '● RECORDING · WAIT',
          disabled: true
        });
      }

      buttons.push({
        label: '≫ SKIP QUESTION',
        event: 'host:skip'
      });

      buttons.push({
        label: '× END GAME',
        event: 'host:end'
      });

      return {
        buttons,
        hint: freeAnswerPhaseHint(s)
      };
    }

    case 'REVEAL':
      return {
        buttons: [
          {
            label: '▸ SHOW LEADERBOARD',
            event: 'host:showLeaderboard',
            primary: true
          },
          {
            label: '× END GAME',
            event: 'host:end'
          }
        ],
        hint: 'REVIEW ANSWERS · THEN SHOW LEADERBOARD'
      };

    case 'LEADERBOARD':
      return {
        buttons: [
          {
            label: s.qNum < s.qTotal
              ? '▸ NEXT QUESTION'
              : '▸ FINAL PODIUM',
            event: 'host:next',
            primary: true
          },
          {
            label: '× END GAME',
            event: 'host:end'
          }
        ],
        hint:
          s.qNum < s.qTotal
            ? `${s.qTotal - s.qNum} QUESTION${s.qTotal - s.qNum === 1 ? '' : 'S'} REMAINING`
            : 'FINAL QUESTION'
      };

    case 'PODIUM':
      return {
        buttons: [{
          label: '↺ NEW GAME (SAME ROOM)',
          event: 'host:newGame',
          primary: true
        }],
        hint: 'SCORES RESET · GAME CONFIGURATION KEPT'
      };

    default:
      return {
        buttons: [],
        hint: ''
      };
  }
}


function freeAnswerPhaseHint(s) {
  switch (s.freeAnswerPhase) {
    case 'active':
      return 'ANSWERING · TIMER IS RUNNING';

    case 'paused':
      return 'PAUSED BY OPERATOR';

    case 'recording':
      return 'RECORDING ANSWERS · FINAL 10S';

    default:
      return '';
  }
}


function renderOpButtons() {
  const box = $('op-btns');

  if (!box) return;

  box.innerHTML = '';

  const { buttons, hint } = opControls(sync);

  for (const spec of buttons) {
    const button = document.createElement('button');

    button.className =
      'btn' +
      (spec.primary ? ' primary' : '');

    button.textContent = spec.label;
    button.disabled = !!spec.disabled;

    if (spec.event) {
      button.addEventListener('click', () => {
        socket.emit(spec.event);
      });
    }

    box.appendChild(button);
  }

  $('op-hint').textContent = hint;
}


/* -------------------------------------------------------------------------- */
/* PLAYERS / TEAMS                                                            */
/* -------------------------------------------------------------------------- */

function playerDotClass(player) {
  if (!player.connected) {
    return 'offline';
  }

  if (player.answered) {
    return 'answered';
  }

  return 'online';
}


function renderPlayers() {
  const box = $('player-list');

  if (!box || !sync) return;

  box.innerHTML = '';

  if (!sync.players || !sync.players.length) {
    box.innerHTML =
      '<div class="hint">NO TEAMS CONNECTED</div>';

    return;
  }

  for (const player of sync.players) {
    const row = document.createElement('div');

    row.className = 'p-row';

    row.innerHTML = `
      <span class="p-dot ${playerDotClass(player)}"></span>
      <span class="p-name">${esc(player.nickname)}</span>
      <span class="p-type">${player.connected ? 'PHONE' : 'OFFLINE'}</span>
      <span class="p-score">${fmt(player.score)}</span>
    `;

    const kick = document.createElement('button');

    kick.className = 'p-kick';
    kick.textContent = 'KICK';

    kick.addEventListener('click', () => {
      socket.emit('host:kick', {
        token: player.token
      });
    });

    row.appendChild(kick);
    box.appendChild(row);
  }
}


function renderTeams() {
  const box = $('team-list');

  if (!box || !sync) return;

  box.innerHTML = '';

  const players = Array.isArray(sync.players)
    ? [...sync.players]
    : [];

  players.sort((a, b) => {
    if (a.connected !== b.connected) {
      return a.connected ? -1 : 1;
    }

    return Number(b.score || 0) - Number(a.score || 0);
  });

  if (!players.length) {
    box.innerHTML =
      '<div class="hint">NO TEAMS CONNECTED</div>';

    return;
  }

  for (const player of players) {
    const row = document.createElement('div');

    row.className = 'p-row';

    row.innerHTML = `
      <span class="p-dot ${playerDotClass(player)}"></span>
      <span class="p-name">${esc(player.nickname)}</span>
      <span class="p-type">
        ${player.connected ? 'CONNECTED' : 'OFFLINE'}
      </span>
      <span class="p-score">${fmt(player.score)}</span>
    `;

    box.appendChild(row);
  }
}


/* -------------------------------------------------------------------------- */
/* FREE-ANSWER GAME SETUP                                                     */
/* -------------------------------------------------------------------------- */

function copyRoundsFromServer() {
  const game = sync?.freeAnswerGame;

  if (!game || !Array.isArray(game.rounds)) {
    return;
  }

  freeRounds = game.rounds.map(round => ({
    number: round.number,
    questions: (round.questions || []).map(question => ({
      number: question.number,
      type: question.type
    }))
  }));

  freeRoundsInitialized = true;
}


function renderFreeAnswerSetup() {
  if (!freeRoundsDirty || !freeRoundsInitialized) {
    copyRoundsFromServer();
  }

  renderFreeRounds();
}


function markFreeRoundsDirty() {
  freeRoundsDirty = true;
}


function renderFreeRounds() {
  const box = $('free-rounds');

  if (!box) return;

  box.innerHTML = '';

  if (!freeRounds.length) {
    box.innerHTML =
      '<div class="hint">NO ROUNDS CONFIGURED</div>';

    return;
  }

  freeRounds.forEach((round, roundIndex) => {
    const row = document.createElement('div');

    row.className = 'free-round';

    row.innerHTML = `
      <div class="free-round-head">
        <span>ROUND ${round.number}</span>
        <button class="btn xs danger-hover">REMOVE</button>
      </div>

      <div class="free-questions"></div>

      <button class="btn xs">+ QUESTION</button>
    `;

    const questions =
      row.querySelector('.free-questions');

    round.questions.forEach((question, questionIndex) => {
      const q = document.createElement('div');

      q.className = 'free-question';

      q.innerHTML = `
        <span>Q${question.number}</span>

        <select>
          <option value="normal">NORMAL</option>
          <option value="duplet">DUPLET</option>
          <option value="blitz">BLITZ</option>
        </select>

        <button class="btn xs danger-hover">×</button>
      `;

      const select = q.querySelector('select');

      select.value = question.type;

      select.addEventListener('change', () => {
        question.type = select.value;
        markFreeRoundsDirty();
      });

      q.querySelector('button')
        .addEventListener('click', () => {
          round.questions.splice(questionIndex, 1);

          renumberRound(round);
          markFreeRoundsDirty();

          renderFreeRounds();
        });

      questions.appendChild(q);
    });

    row.querySelector('.free-round-head button')
      .addEventListener('click', () => {
        freeRounds.splice(roundIndex, 1);

        renumberRounds();
        markFreeRoundsDirty();

        renderFreeRounds();
      });

    row.querySelector('.free-questions + button')
      .addEventListener('click', () => {
        round.questions.push({
          number: round.questions.length + 1,
          type: 'normal'
        });

        markFreeRoundsDirty();
        renderFreeRounds();
      });

    box.appendChild(row);
  });
}


function renumberRound(round) {
  round.questions.forEach((question, index) => {
    question.number = index + 1;
  });
}


function renumberRounds() {
  freeRounds.forEach((round, index) => {
    round.number = index + 1;
    renumberRound(round);
  });
}


$('free-add-round').addEventListener('click', () => {
  freeRounds.push({
    number: freeRounds.length + 1,
    questions: [{
      number: 1,
      type: 'normal'
    }]
  });

  markFreeRoundsDirty();
  renderFreeRounds();
});


$('free-save').addEventListener('click', () => {
  if (!freeRounds.length) {
    showFreeSaveMessage('ADD AT LEAST ONE ROUND', true);
    return;
  }

  if (freeRounds.some(round => !round.questions.length)) {
    showFreeSaveMessage(
      'EVERY ROUND MUST CONTAIN AT LEAST ONE QUESTION',
      true
    );

    return;
  }

  renumberRounds();

  socket.emit('host:configureFreeAnswer', {
    rounds: freeRounds
  });

  freeRoundsDirty = false;
  freeRoundsInitialized = true;

  showFreeSaveMessage('FREE-ANSWER GAME SAVED');
});


$('free-clear').addEventListener('click', () => {
  socket.emit('host:clearFreeAnswer');

  freeRounds = [];
  freeRoundsDirty = false;
  freeRoundsInitialized = true;

  renderFreeRounds();

  showFreeSaveMessage('FREE-ANSWER GAME CLEARED');
});


function showFreeSaveMessage(message, error = false) {
  const el = $('free-save-msg');

  el.textContent = message;
  el.classList.toggle('err', error);
  el.hidden = false;

  clearTimeout(showFreeSaveMessage.timer);

  showFreeSaveMessage.timer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}


/* -------------------------------------------------------------------------- */
/* CURRENT GAME                                                               */
/* -------------------------------------------------------------------------- */

function currentQuestion() {
  const index = Number(sync?.currentIndex ?? sync?.qNum - 1);

  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  const rounds = sync?.freeAnswerGame?.rounds || [];

  let offset = 0;

  for (const round of rounds) {
    const count = round.questions?.length || 0;

    if (index < offset + count) {
      return {
        round,
        question: round.questions[index - offset],
        index
      };
    }

    offset += count;
  }

  return null;
}


function renderCurrentGame() {
  if (!sync) return;

  const current = currentQuestion();

  if (!current) {
    $('current-round').textContent = '—';
    $('current-question').textContent = '—';
    $('current-type').textContent = '—';
    $('current-phase').textContent = 'WAITING FOR GAME';

    return;
  }

  $('current-round').textContent =
    current.round.number;

  $('current-question').textContent =
    current.question.number;

  $('current-type').textContent =
    String(current.question.type || 'normal').toUpperCase();

  if (sync.state !== 'QUESTION_ACTIVE') {
    $('current-phase').textContent =
      String(sync.state || 'LOBBY').replaceAll('_', ' ');

    return;
  }

  $('current-phase').textContent =
    freeAnswerPhaseHint(sync);
}


/* -------------------------------------------------------------------------- */
/* ADMIN QUESTION TIMER                                                       */
/* -------------------------------------------------------------------------- */

function timerRemainingMs() {
  if (!sync || sync.state !== 'QUESTION_ACTIVE') {
    return null;
  }

  if (sync.freeAnswerPhase === 'paused') {
    const pausedRemaining = Number(sync.freeAnswerRemainingMs);

    return Number.isFinite(pausedRemaining)
      ? Math.max(0, pausedRemaining)
      : null;
  }

  const phase = sync.freeAnswerPhase;

  if (phase !== 'active' && phase !== 'recording') {
    return null;
  }

  const phaseStart = Number(sync.freeAnswerPhaseStart);
  const phaseLimit = Number(sync.freeAnswerPhaseLimit);

  if (
    Number.isFinite(phaseStart) &&
    Number.isFinite(phaseLimit) &&
    phaseLimit > 0
  ) {
    const elapsed = Date.now() - phaseStart;

    return Math.max(0, phaseLimit - elapsed);
  }

  const remaining = Number(sync.freeAnswerRemainingMs);

  return Number.isFinite(remaining)
    ? Math.max(0, remaining)
    : null;
}


function formatTimer(ms) {
  if (ms === null || !Number.isFinite(ms)) {
    return '—';
  }

  const seconds = Math.ceil(ms / 1000);

  return String(seconds).padStart(2, '0');
}


function updateAdminTimer() {
  const timer = $('admin-timer');
  const fill = $('admin-timer-fill');

  if (!timer || !fill) return;

  const active =
    sync?.state === 'QUESTION_ACTIVE';

  const phase = sync?.freeAnswerPhase;

  if (!active || !phase) {
    timer.textContent = '—';
    timer.classList.remove('low');
    fill.classList.remove('low');
    fill.style.width = '0%';
    return;
  }

  const remaining = timerRemainingMs();

  if (remaining === null) {
    timer.textContent = '—';
    return;
  }

  timer.textContent = formatTimer(remaining);

  const isLow =
    phase === 'recording' ||
    remaining <= 10000;

  timer.classList.toggle('low', isLow);
  fill.classList.toggle('low', isLow);

  const limit = Number(sync.freeAnswerPhaseLimit);

  if (Number.isFinite(limit) && limit > 0) {
    const percent = Math.max(
      0,
      Math.min(100, remaining / limit * 100)
    );

    fill.style.width = `${percent}%`;
  } else {
    fill.style.width = '0%';
  }
}


if (timerInterval) {
  clearInterval(timerInterval);
}

timerInterval = setInterval(updateAdminTimer, 100);


/* -------------------------------------------------------------------------- */
/* ROUND RESULTS                                                              */
/* -------------------------------------------------------------------------- */

/*
 * The server snapshot contains answers for all questions.
 *
 * The renderer accepts either:
 *   - an array of question result objects;
 *   - an object keyed by question index.
 *
 * Each question result should contain:
 *   questionIndex, roundNumber, questionNumber, answers / teams.
 *
 * Each answer should contain:
 *   token, nickname, answer, correct.
 */

function getRoundResultsData() {
  const data = sync?.freeAnswerAnswers;

  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === 'object') {
    return Object.entries(data).map(([index, value]) => {
      if (Array.isArray(value)) {
        return {
          questionIndex: Number(index),
          answers: value
        };
      }

      return Object.assign(
        { questionIndex: Number(index) },
        value
      );
    });
  }

  return [];
}


function flattenQuestions() {
  const rounds = sync?.freeAnswerGame?.rounds || [];

  const result = [];
  let globalIndex = 0;

  for (const round of rounds) {
    for (const question of round.questions || []) {
      result.push({
        index: globalIndex,
        roundNumber: round.number,
        questionNumber: question.number,
        type: question.type
      });

      globalIndex++;
    }
  }

  return result;
}


function getSelectedRoundNumber() {
  const select = $('results-round');

  if (!select) return null;

  const value = Number(select.value);

  return Number.isFinite(value)
    ? value
    : null;
}


function populateResultsRoundSelect() {
  const select = $('results-round');

  if (!select || !sync) return;

  const previous = select.value;
  const rounds = sync.freeAnswerGame?.rounds || [];

  select.innerHTML = '';

  if (!rounds.length) {
    const option = document.createElement('option');

    option.value = '';
    option.textContent = 'NO ROUNDS';

    select.appendChild(option);
    select.disabled = true;

    return;
  }

  select.disabled = false;

  rounds.forEach(round => {
    const option = document.createElement('option');

    option.value = String(round.number);
    option.textContent = `ROUND ${round.number}`;

    select.appendChild(option);
  });

  const stillExists = rounds.some(
    round => String(round.number) === previous
  );

  if (stillExists) {
    select.value = previous;
  } else {
    const current = currentQuestion();

    select.value = String(
      current?.round.number ?? rounds[0].number
    );
  }
}


function normalizeQuestionAnswers(questionResult) {
  if (Array.isArray(questionResult.answers)) {
    return questionResult.answers;
  }

  if (Array.isArray(questionResult.teams)) {
    return questionResult.teams;
  }

  if (Array.isArray(questionResult.results)) {
    return questionResult.results;
  }

  return [];
}


function findQuestionResult(questionIndex, results) {
  return results.find(item => {
    return Number(item.questionIndex) === Number(questionIndex);
  });
}


function answerForToken(questionResult, token) {
  if (!questionResult) return null;

  const answers = normalizeQuestionAnswers(questionResult);

  return answers.find(item => item.token === token) || null;
}


function renderRoundResults() {
  if (!sync) return;

  const head = $('round-results-head');
  const body = $('round-results-body');

  if (!head || !body) return;

  populateResultsRoundSelect();

  const roundNumber = getSelectedRoundNumber();

  const rounds = sync.freeAnswerGame?.rounds || [];

  const round = rounds.find(
    item => Number(item.number) === roundNumber
  );

  if (!round) {
    head.innerHTML = '';
    body.innerHTML =
      '<tr><td class="empty-cell">NO ROUND SELECTED</td></tr>';

    return;
  }

  const questions = flattenQuestions()
    .filter(question => {
      return Number(question.roundNumber) === roundNumber;
    });

  const players = Array.isArray(sync.players)
    ? [...sync.players]
    : [];

  const results = getRoundResultsData();

  head.innerHTML = '';

  const headerRow = document.createElement('tr');

  const teamHeader = document.createElement('th');
  teamHeader.textContent = 'TEAM';
  headerRow.appendChild(teamHeader);

  questions.forEach(question => {
    const th = document.createElement('th');

    th.textContent =
      `Q${question.questionNumber} · ${String(question.type || 'normal').toUpperCase()}`;

    headerRow.appendChild(th);
  });

  head.appendChild(headerRow);

  body.innerHTML = '';

  if (!players.length) {
    body.innerHTML =
      `<tr><td colspan="${questions.length + 1}" class="empty-cell">NO TEAMS</td></tr>`;

    return;
  }

  if (!questions.length) {
    body.innerHTML =
      '<tr><td class="empty-cell">NO QUESTIONS IN THIS ROUND</td></tr>';

    return;
  }

  players.sort((a, b) => {
    return String(a.nickname)
      .localeCompare(String(b.nickname));
  });

  for (const player of players) {
    const row = document.createElement('tr');

    const teamCell = document.createElement('td');

    teamCell.className = 'team-cell';
    teamCell.textContent = player.nickname;

    row.appendChild(teamCell);

    for (const question of questions) {
      const td = document.createElement('td');

      const questionResult = findQuestionResult(
        question.index,
        results
      );

      const answerResult = answerForToken(
        questionResult,
        player.token
      );

      const answer =
        answerResult?.answer ??
        answerResult?.draft ??
        '';

      const correct =
        !!answerResult?.correct;

      td.className = 'round-answer-cell';

      if (correct) {
        td.classList.add('correct');
      }

      if (!answerResult || !String(answer).trim()) {
        td.classList.add('empty');
        td.textContent = '—';
      } else {
        td.textContent = String(answer);
        td.title = correct
          ? 'CORRECT · CLICK TO REMOVE +1'
          : 'CLICK TO AWARD +1';
      }

      if (answerResult) {
        td.addEventListener('click', () => {
          socket.emit('host:gradeFreeAnswer', {
            questionIndex: question.index,
            token: player.token
          });
        });
      }

      row.appendChild(td);
    }

    body.appendChild(row);
  }
}


$('results-round')?.addEventListener('change', () => {
  renderRoundResults();
});


/* -------------------------------------------------------------------------- */
/* SCOREBOARD                                                                 */
/* -------------------------------------------------------------------------- */

function renderScoreboard() {
  const list = $('score-list');

  if (!list || !sync) return;

  list.innerHTML = '';

  const players = Array.isArray(sync.players)
    ? [...sync.players]
    : [];

  players.sort((a, b) => {
    const scoreDiff =
      Number(b.score || 0) -
      Number(a.score || 0);

    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return String(a.nickname)
      .localeCompare(String(b.nickname));
  });

  if (!players.length) {
    list.innerHTML =
      '<tr><td colspan="3" class="hint">NO TEAMS</td></tr>';

    return;
  }

  players.forEach((player, index) => {
    const row = document.createElement('tr');

    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${esc(player.nickname)}</td>
      <td class="score-cell">${fmt(player.score)}</td>
    `;

    list.appendChild(row);
  });
}


/* -------------------------------------------------------------------------- */
/* PRESENTATION SETTINGS                                                      */
/* -------------------------------------------------------------------------- */

const ACCENT_PRESETS = [
  '#56ff8a',
  '#55e6ff',
  '#ffb347',
  '#ff6ad5',
  '#ff6a6a',
  '#b98cff',
  '#ffffff'
];


function renderPresentation() {
  if (!settings) return;

  const bankName =
    settings.bankName || 'LOCAL BROADCAST';

  const accent =
    (settings.accent || ACCENT_DEFAULT)
      .toLowerCase();

  $('bank-name-preview').textContent =
    bankName.toUpperCase();

  if (document.activeElement !== $('set-bankname')) {
    $('set-bankname').value =
      settings.bankName || '';
  }

  if (document.activeElement !== $('set-accent')) {
    $('set-accent').value = accent;
  }

  $('accent-hex').textContent = accent;

  $('accent-reset').disabled =
    accent === ACCENT_DEFAULT;

  for (const swatch of $('accent-swatches').children) {
    swatch.classList.toggle(
      'on',
      swatch.dataset.hex === accent
    );
  }

  applyAccent(accent);
}


function renderSettings() {
  renderPresentation();
}


function buildAccentSwatches() {
  const box = $('accent-swatches');

  if (!box) return;

  box.innerHTML = '';

  for (const hex of ACCENT_PRESETS) {
    const button = document.createElement('button');

    button.className = 'swatch';
    button.dataset.hex = hex;
    button.style.background = hex;
    button.title = hex;

    button.addEventListener('click', () => {
      setAccent(hex);
    });

    box.appendChild(button);
  }
}


buildAccentSwatches();


function setAccent(hex) {
  hex = String(hex).toLowerCase();

  applyAccent(hex);

  $('accent-hex').textContent = hex;

  putSettings({
    accent: hex
  });
}


$('set-accent').addEventListener('input', event => {
  const hex =
    event.target.value.toLowerCase();

  $('accent-hex').textContent = hex;

  applyAccent(hex);
});


$('set-accent').addEventListener('change', event => {
  setAccent(event.target.value);
});


$('accent-reset').addEventListener('click', () => {
  setAccent(ACCENT_DEFAULT);
});


$('set-bankname').addEventListener('input', event => {
  const value =
    event.target.value.trim() ||
    'LOCAL BROADCAST';

  $('bank-name-preview').textContent =
    value.toUpperCase();
});


$('set-bankname').addEventListener('change', event => {
  putSettings({
    bankName: event.target.value
  });
});


async function putSettings(patch) {
  const { ok, data } =
    await api('/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patch)
    });

  if (!ok) {
    console.error(
      '[admin] settings update failed:',
      data
    );

    return;
  }

  settings = data;

  renderSettings();
}