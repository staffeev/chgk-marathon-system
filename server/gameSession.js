'use strict';

const crypto = require('node:crypto');
const { rankPlayers } = require('./scoring');

const FREE_ANSWER_RECORDING_SECONDS = 10;
const FREE_ANSWER_RECORDING_GRACE_SECONDS = 3;

const FREE_ANSWER_RECORDING_TOTAL_MS =
  (FREE_ANSWER_RECORDING_SECONDS +
    FREE_ANSWER_RECORDING_GRACE_SECONDS) * 1000;

// In-memory session state machine.
// LOBBY → QUESTION_ACTIVE → REVEAL → LEADERBOARD → … → PODIUM → LOBBY
//
// The session never talks to Socket.IO directly: index.js injects a `bus`.

class GameSession {
  constructor({ repo, bus }) {
    this.repo = repo;
    this.bus = bus;

    this.pin = String(
      1000 + Math.floor(Math.random() * 9000)
    );

    this.players = new Map();

    this.resetGame();

    this.tickTimer = setInterval(
      () => this.tick(),
      100
    );

    this.tickTimer.unref?.();
  }

  resetGame() {
    this.state = 'LOBBY';

    this.order = [];
    this.idx = -1;
    this.current = null;

    this.qStart = 0;
    this.qLimit = 60;

    this.freeAnswerGame = null;

    this.freeAnswerPhase = null;
    this.freeAnswerPhaseStart = 0;
    this.freeAnswerPhaseLimit = 0;
    this.freeAnswerSubQuestion = 0;

    // Additional pause information:
    //
    // manual:
    //   Resume the same subquestion with its remaining time.
    //
    // between-subquestions:
    //   Resume the next subquestion with its full time limit.
    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    // questionIndex -> Map<playerToken, result>
    //
    // result:
    // {
    //   answer: string,
    //   correct: boolean
    // }
    this.freeAnswerResults = new Map();

    this.prevRanks = null;
    this.deltas = new Map();

    this.clearAuto();
  }

  settings() {
    return this.repo.getSettings();
  }

  connected() {
    return [...this.players.values()]
      .filter(p => p.connected);
  }

  eligible() {
    return this.connected()
      .filter(p => p.eligibleFrom <= this.idx);
  }

  scoringPool() {
    return [...this.players.values()]
      .filter(p => p.eligibleFrom <= this.idx);
  }

  clearAuto() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  }

  // ---- free-answer game configuration ----

  configureFreeAnswerGame(rounds) {
    if (this.state !== 'LOBBY') {
      return false;
    }

    if (!Array.isArray(rounds) || !rounds.length) {
      return false;
    }

    const normalized = rounds.map(
      (round, roundIndex) => {
        const questions =
          Array.isArray(round.questions)
            ? round.questions
            : [];

        return {
          number:
            Number.isInteger(round.number)
              ? round.number
              : roundIndex + 1,

          questions:
            questions.map(
              (question, questionIndex) => ({
                number:
                  Number.isInteger(question.number)
                    ? question.number
                    : questionIndex + 1,

                type:
                  [
                    'normal',
                    'duplet',
                    'blitz'
                  ].includes(question.type)
                    ? question.type
                    : 'normal'
              })
            )
        };
      }
    );

    if (
      normalized.some(
        round =>
          !round.questions.length
      )
    ) {
      return false;
    }

    this.freeAnswerGame = {
      rounds: normalized
    };

    this.freeAnswerResults = new Map();

    return true;
  }

  clearFreeAnswerGame() {
    if (this.state !== 'LOBBY') {
      return false;
    }

    this.freeAnswerGame = null;
    this.freeAnswerResults = new Map();

    return true;
  }

  freeAnswerQuestionCount() {
    if (!this.freeAnswerGame) {
      return 0;
    }

    return this.freeAnswerGame.rounds.reduce(
      (total, round) =>
        total + round.questions.length,
      0
    );
  }

  // ---- players ----

  join(pin, nickname, socketId) {
    const name =
      String(nickname || '').trim();

    if (
      String(pin || '').trim() !==
      this.pin
    ) {
      return {
        error: {
          code: 'WRONG_PIN',
          message:
            'WRONG PIN — CHECK THE BIG SCREEN'
        }
      };
    }

    if (
      name.length < 1 ||
      name.length > 20
    ) {
      return {
        error: {
          code: 'BAD_NICKNAME',
          message:
            'NICKNAME MUST BE 1–20 CHARS'
        }
      };
    }

    if (
      this.connected().some(
        p =>
          p.nickname.toLowerCase() ===
          name.toLowerCase()
      )
    ) {
      return {
        error: {
          code: 'NICKNAME_TAKEN',
          message:
            'NICKNAME TAKEN — PICK ANOTHER'
        }
      };
    }

    const player = {
      token:
        crypto
          .randomBytes(9)
          .toString('hex'),

      nickname: name,

      socketId,

      connected: true,

      score: 0,
      cumTimeMs: 0,

      eligibleFrom:
        this.state === 'LOBBY'
          ? 0
          : this.idx + 1,

      current: null,
      lastResult: null,

      joinedAt: Date.now()
    };

    this.players.set(
      player.token,
      player
    );

    this.bus.playersChanged({
      joined: player.nickname
    });

    return { player };
  }

  resume(token, socketId) {
    const p =
      this.players.get(token);

    if (!p) {
      return null;
    }

    p.connected = true;
    p.socketId = socketId;

    this.bus.playersChanged({});

    return p;
  }

  disconnectSocket(socketId) {
    const p =
      [...this.players.values()]
        .find(
          x => x.socketId === socketId
        );

    if (!p) {
      return;
    }

    p.connected = false;
    p.socketId = null;

    this.bus.playersChanged({});
  }

  kick(token) {
    const p =
      this.players.get(token);

    if (!p) {
      return;
    }

    this.players.delete(token);

    if (p.socketId) {
      this.bus.kicked(p.socketId);
    }

    this.bus.playersChanged({});
  }

  // ---- game flow ----

  start() {
    if (this.state !== 'LOBBY') {
      return;
    }

    if (!this.connected().length) {
      return;
    }

    if (
      !this.freeAnswerGame ||
      !this.freeAnswerGame.rounds.length
    ) {
      return;
    }

    this.order =
      this.freeAnswerGame.rounds.flatMap(
        round =>
          round.questions.map(
            question => ({
              roundNumber:
                round.number,

              questionNumber:
                question.number,

              type:
                question.type
            })
          )
      );

    if (!this.order.length) {
      return;
    }

    this.idx = -1;
    this.prevRanks = null;
    this.deltas = new Map();
    this.freeAnswerResults = new Map();

    for (
      const p of this.players.values()
    ) {
      p.score = 0;
      p.cumTimeMs = 0;
      p.current = null;
      p.lastResult = null;
      p.eligibleFrom = 0;

      delete p.freeAnswerDraft;
    }

    this.nextQuestion();
  }

  nextQuestion() {
    this.clearAuto();

    this.idx++;

    if (
      this.idx >=
      this.order.length
    ) {
      return this.podium();
    }

    this.current =
      this.order[this.idx];

    this.qLimit = 60;

    this.freeAnswerPhase =
      'active';

    this.freeAnswerPhaseStart =
      Date.now();

    this.freeAnswerPhaseLimit =
      this.getActivePhaseLimit();

    this.freeAnswerSubQuestion = 1;

    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    this.qStart =
      this.freeAnswerPhaseStart;

    this.state =
      'QUESTION_ACTIVE';

    for (
      const p of this.players.values()
    ) {
      p.current = null;
      p.lastResult = null;

      delete p.freeAnswerDraft;
    }

    this.bus.questionStart(
      this.questionStartPayload()
    );
  }

  getActivePhaseLimit() {
    if (
      this.current?.type ===
      'duplet'
    ) {
      return 30;
    }

    if (
      this.current?.type ===
      'blitz'
    ) {
      return 20;
    }

    return 60;
  }

  getSubQuestionCount() {
    if (
      this.current?.type ===
      'duplet'
    ) {
      return 2;
    }

    if (
      this.current?.type ===
      'blitz'
    ) {
      return 3;
    }

    return 1;
  }

  questionStartPayload(elapsedMs = 0) {
    const q = this.current;

    let remainingMs = null;

    if (this.freeAnswerPhase === 'paused') {
      // При паузе возвращаем сохранённый остаток.
      remainingMs = this.freeAnswerRemainingMs;
    } else if (this.freeAnswerPhase === 'active') {
      // При активной фазе вычисляем реальное оставшееся время.
      remainingMs = Math.max(
        0,
        this.freeAnswerPhaseLimit * 1000 - elapsedMs
      );
    } else if (this.freeAnswerPhase === 'recording') {
      // Клиент видит только 10 секунд.
      // Дополнительные 3 секунды остаются невидимыми.
      remainingMs = Math.max(
        0,
        FREE_ANSWER_RECORDING_SECONDS * 1000 - elapsedMs
      );
    }

    return {
      index: this.idx,

      qNum: this.idx + 1,
      total: this.order.length,

      freeAnswer: true,

      roundNumber: q?.roundNumber,
      questionNumber: q?.questionNumber,
      type: q?.type,

      timeLimit: this.qLimit,

      serverStartTime: this.qStart,
      elapsedMs,

      phase: this.freeAnswerPhase,
      subQuestion: this.freeAnswerSubQuestion,

      phaseTimeLimit: this.freeAnswerPhaseLimit,
      phaseStartTime: this.freeAnswerPhaseStart,

      pauseReason: this.freeAnswerPauseReason,
      remainingMs
    };
  }

  // ---- free-answer drafts and submissions ----

  updateFreeAnswerDraft(token, answer) {
    if (this.state !== 'QUESTION_ACTIVE') {
      return false;
    }

    const p =
      this.players.get(token);

    if (
      !p ||
      !p.connected ||
      p.eligibleFrom > this.idx
    ) {
      return false;
    }

    // A submitted answer is immutable.
    if (p.current) {
      return false;
    }

    const elapsedMs =
      Date.now() -
      this.freeAnswerPhaseStart;

    if (this.freeAnswerPhase === 'active') {
      if (
        elapsedMs >=
        this.freeAnswerPhaseLimit * 1000
      ) {
        this.tick();
        return false;
      }
    } else if (this.freeAnswerPhase === 'recording') {
      if (
        elapsedMs >=
        FREE_ANSWER_RECORDING_TOTAL_MS
      ) {
        this.finalizeFreeAnswer();
        return false;
      }
    } else {
      return false;
    }

    // Save the draft without submitting or locking it.
    this.setFreeAnswerDraft(p, answer);

    return true;
  }

  setFreeAnswerDraft(player, answer) {
    player.freeAnswerDraft =
      String(answer ?? '');
  }

  submitFreeAnswer(token, answer) {
    if (this.state !== 'QUESTION_ACTIVE') {
      return;
    }

    const p =
      this.players.get(token);

    if (
      !p ||
      !p.connected ||
      p.eligibleFrom > this.idx
    ) {
      return;
    }

    const elapsedMs =
      Date.now() -
      this.freeAnswerPhaseStart;

    // The server is authoritative for active-phase deadlines.
    if (
      this.freeAnswerPhase === 'active' &&
      elapsedMs >=
        this.freeAnswerPhaseLimit * 1000
    ) {
      this.tick();
      return;
    }

    // The visible recording timer is 10 seconds.
    // The server accepts submissions for 3 additional hidden seconds.
    if (
      this.freeAnswerPhase === 'recording' &&
      elapsedMs >= FREE_ANSWER_RECORDING_TOTAL_MS
    ) {
      this.finalizeFreeAnswer();
      return;
    }

    if (
      this.freeAnswerPhase !== 'active' &&
      this.freeAnswerPhase !== 'recording'
    ) {
      return;
    }

    // A submitted answer cannot be changed or submitted again.
    if (p.current) {
      return;
    }

    const value =
      String(answer ?? '');

    // Keep the final submitted text as the current draft too.
    this.setFreeAnswerDraft(p, value);

    p.current = {
      answer: value,

      elapsedMs:
        this.freeAnswerPhase === 'active'
          ? elapsedMs
          : this.qLimit * 1000,

      locked: true
    };

    this.bus.answerAck(
      p,
      {
        locked: true
      }
    );

    this.bus.answeredCount(
      this.answeredCount()
    );
  }

  // Compatibility wrapper for server/index.js.
  pauseFreeAnswer() {
    return this.startFreeAnswerPause('manual');
  }

  startFreeAnswerPause(reason = 'manual') {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return false;
    }

    if (
      this.freeAnswerPhase !==
      'active'
    ) {
      return false;
    }

    const elapsedMs =
      Date.now() -
      this.freeAnswerPhaseStart;

    const phaseDurationMs =
      this.freeAnswerPhaseLimit * 1000;

    /*
     * If the timer has already expired,
     * handle the automatic transition directly.
     * Do not call tick() here: it can call this
     * method again and cause infinite recursion.
     */
    if (elapsedMs >= phaseDurationMs) {
      if (
        this.freeAnswerSubQuestion <
        this.getSubQuestionCount()
      ) {
        this.freeAnswerPauseReason =
          'between-subquestions';

        this.freeAnswerRemainingMs = null;

        this.freeAnswerPhase =
          'paused';

        this.freeAnswerPhaseStart =
          Date.now();

        this.freeAnswerPhaseLimit = 0;

        this.bus.freeAnswerPhase({
          phase: 'paused',

          subQuestion:
            this.freeAnswerSubQuestion,

          pauseReason:
            this.freeAnswerPauseReason,

          remainingMs:
            this.freeAnswerRemainingMs
        });

        return true;
      }

      return this.finishFreeAnswerActive();
    }

    this.freeAnswerPauseReason =
      reason === 'between-subquestions'
        ? 'between-subquestions'
        : 'manual';

    if (
      this.freeAnswerPauseReason ===
      'manual'
    ) {
      this.freeAnswerRemainingMs =
        Math.max(
          0,
          phaseDurationMs - elapsedMs
        );
    } else {
      this.freeAnswerRemainingMs = null;
    }

    this.freeAnswerPhase =
      'paused';

    this.freeAnswerPhaseStart =
      Date.now();

    this.freeAnswerPhaseLimit = 0;

    this.bus.freeAnswerPhase({
      phase: 'paused',

      subQuestion:
        this.freeAnswerSubQuestion,

      pauseReason:
        this.freeAnswerPauseReason,

      remainingMs:
        this.freeAnswerRemainingMs
    });

    return true;
  }

  resumeFreeAnswer() {
    if (
      this.state !== 'QUESTION_ACTIVE' ||
      this.freeAnswerPhase !== 'paused'
    ) {
      return false;
    }

    const maxSubQuestions = this.getSubQuestionCount();
    const isBetweenSubQuestions =
      this.freeAnswerPauseReason === 'between-subquestions';

    let elapsedMs = 0;

    if (isBetweenSubQuestions) {
      // Автоматическая пауза между частями duplet/blitz:
      // начинаем следующую часть с полным временем.
      const nextSubQuestion = this.freeAnswerSubQuestion + 1;

      if (nextSubQuestion > maxSubQuestions) {
        return this.finishFreeAnswerActive();
      }

      this.freeAnswerSubQuestion = nextSubQuestion;
      this.freeAnswerPhaseLimit = this.getActivePhaseLimit();
      this.freeAnswerPhaseStart = Date.now();
    } else {
      // Ручная пауза: сохраняем исходную длительность фазы,
      // а прошедшее до паузы время восстанавливаем через phaseStart.
      const originalLimit = this.getActivePhaseLimit();
      const remainingMs =
        this.freeAnswerRemainingMs ?? originalLimit * 1000;

      if (remainingMs <= 0) {
        if (this.freeAnswerSubQuestion < maxSubQuestions) {
          this.freeAnswerPauseReason = 'between-subquestions';
          this.freeAnswerRemainingMs = null;
          return this.resumeFreeAnswer();
        }

        return this.finishFreeAnswerActive();
      }

      this.freeAnswerPhaseLimit = originalLimit;
      elapsedMs = Math.max(0, originalLimit * 1000 - remainingMs);
      this.freeAnswerPhaseStart = Date.now() - elapsedMs;
    }

    this.freeAnswerPhase = 'active';
    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    elapsedMs = Math.max(0, Date.now() - this.freeAnswerPhaseStart);

    const phaseDurationMs = this.freeAnswerPhaseLimit * 1000;
    const remainingMs = Math.max(0, phaseDurationMs - elapsedMs);

    this.bus.freeAnswerPhase({
      phase: 'active',
      subQuestion: this.freeAnswerSubQuestion,
      timeLimit: this.freeAnswerPhaseLimit,
      phaseTimeLimit: this.freeAnswerPhaseLimit,
      elapsedMs,
      remainingMs,
      serverStartTime: this.freeAnswerPhaseStart
    });

    return true;
  }

  finishFreeAnswerActive() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return false;
    }

    if (
      this.freeAnswerPhase !== 'active' &&
      this.freeAnswerPhase !== 'paused'
    ) {
      return false;
    }

    this.freeAnswerPhase =
      'recording';

    this.freeAnswerPhaseStart =
      Date.now();

    this.freeAnswerPhaseLimit =
      FREE_ANSWER_RECORDING_SECONDS;

    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    for (
      const p of this.players.values()
    ) {
      // Submitted answers remain unchanged.
      if (p.current) {
        p.freeAnswerDraft =
          p.current.answer;
      } else if (p.freeAnswerDraft === undefined) {
        p.freeAnswerDraft = '';
      }
    }

    this.bus.freeAnswerPhase({
      phase: 'recording',

      subQuestion:
        this.freeAnswerSubQuestion,

      // The client displays only 10 seconds.
      timeLimit:
        FREE_ANSWER_RECORDING_SECONDS,

      serverStartTime:
        this.freeAnswerPhaseStart
    });

    return true;
  }

  finalizeFreeAnswer() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return false;
    }

    if (
      this.freeAnswerPhase !==
      'recording'
    ) {
      return false;
    }

    for (
      const p of this.players.values()
    ) {
      // Preserve already submitted answers.
      if (p.current) {
        delete p.freeAnswerDraft;
        continue;
      }

      const answer =
        p.freeAnswerDraft ?? '';

      // A non-empty draft becomes the final answer.
      // Empty drafts are not counted as submitted answers.
      if (answer.trim().length > 0) {
        p.current = {
          answer,

          elapsedMs:
            this.qLimit * 1000,

          locked: true
        };
      }

      delete p.freeAnswerDraft;
    }

    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    this.endFreeAnswerQuestion();

    return true;
  }

  endFreeAnswerQuestion() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return false;
    }

    this.clearAuto();

    this.state =
      'REVEAL';

    this.freeAnswerPhase =
      null;

    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    const results =
      new Map();

    for (
      const p of this.scoringPool()
    ) {
      const answer =
        p.current?.answer ?? '';

      p.lastResult = {
        answered:
          !!p.current,

        answer
      };

      results.set(
        p.token,
        {
          answer,
          correct: false
        }
      );
    }

    this.freeAnswerResults.set(
      this.idx,
      results
    );

    this.bus.questionEnd({
      freeAnswer: true,
      questionIndex: this.idx
    });

    return true;
  }

  // ---- manual grading ----

  gradeFreeAnswer(
    questionIndex,
    token
  ) {
    if (
      !Number.isInteger(
        questionIndex
      )
    ) {
      return false;
    }

    const results =
      this.freeAnswerResults.get(
        questionIndex
      );

    const player =
      this.players.get(token);

    if (
      !results ||
      !player
    ) {
      return false;
    }

    const result =
      results.get(token);

    if (!result) {
      return false;
    }

    // Idempotent:
    // repeated click must not add
    // multiple points.
    if (result.correct) {
      return true;
    }

    result.correct = true;

    player.score += 1;

    return true;
  }

  freeAnswerGradingSnapshot(
    questionIndex = this.idx
  ) {
    const results =
      this.freeAnswerResults.get(
        questionIndex
      );

    if (!results) {
      return [];
    }

    return [
      ...results.entries()
    ].map(
      ([token, result]) => {
        const player =
          this.players.get(token);

        return {
          token,

          nickname:
            player?.nickname ??
            '',

          answer:
            result.answer,

          correct:
            result.correct,

          score:
            player?.score ??
            0
        };
      }
    );
  }

  answeredCount() {
    const eligible =
      this.eligible();

    return {
      answered:
        eligible.filter(
          p => p.current
        ).length,

      total:
        eligible.length
    };
  }

  // ---- timer ----

  tick() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return;
    }

    if (
      this.freeAnswerPhase ===
      'active'
    ) {
      const elapsedMs =
        Date.now() -
        this.freeAnswerPhaseStart;

      if (
        elapsedMs >=
        this.freeAnswerPhaseLimit *
          1000
      ) {
        if (
          this.freeAnswerSubQuestion <
          this.getSubQuestionCount()
        ) {
          /*
           * Timer expired before the last part:
           * pause automatically between subquestions.
           * Resume will start the next subquestion.
           */
          this.startFreeAnswerPause(
            'between-subquestions'
          );
        } else {
          this.finishFreeAnswerActive();
        }
      }

      return;
    }

    if (
      this.freeAnswerPhase ===
      'recording'
    ) {
      const elapsedMs =
        Date.now() -
        this.freeAnswerPhaseStart;

      if (
        elapsedMs >=
        FREE_ANSWER_RECORDING_TOTAL_MS
      ) {
        this.finalizeFreeAnswer();
      }
    }
  }

  // ---- leaderboard / podium ----

  showLeaderboard() {
    if (
      this.state !==
      'REVEAL'
    ) {
      return;
    }

    this.clearAuto();

    const { ranks } =
      rankPlayers(
        this.connected()
      );

    this.deltas =
      new Map();

    for (
      const p of this.connected()
    ) {
      const prev =
        this.prevRanks
          ? this.prevRanks.get(
              p.token
            )
          : null;

      this.deltas.set(
        p.token,
        prev
          ? prev -
            ranks.get(
              p.token
            )
          : null
      );
    }

    this.prevRanks =
      ranks;

    this.state =
      'LEADERBOARD';

    this.bus.leaderboard(
      this.leaderboardPayload()
    );

    for (
      const p of this.connected()
    ) {
      if (p.socketId) {
        this.bus.personalRank(
          p,
          {
            rank:
              ranks.get(
                p.token
              ),

            score:
              p.score,

            phase:
              'leaderboard'
          }
        );
      }
    }

    if (
      this.settings()
        .autoAdvance
    ) {
      this.autoTimer =
        setTimeout(
          () => this.next(),
          5000
        );
    }
  }

  leaderboardPayload() {
    const { list, ranks } =
      rankPlayers(
        this.connected()
      );

    return {
      standings:
        list.map(p => ({
          rank:
            ranks.get(
              p.token
            ),

          nickname:
            p.nickname,

          score:
            p.score,

          delta:
            this.deltas.has(
              p.token
            )
              ? this.deltas.get(
                  p.token
                )
              : null
        })),

      afterQuestion:
        this.idx + 1,

      totalQuestions:
        this.order.length,

      remaining:
        Math.max(
          0,
          this.order.length -
            this.idx -
            1
        )
    };
  }

  next() {
    if (
      this.state !==
      'LEADERBOARD'
    ) {
      return;
    }

    this.nextQuestion();
  }

  skip() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return;
    }

    this.nextQuestion();
  }

  endRound() {
    if (
      this.state !==
      'QUESTION_ACTIVE'
    ) {
      return false;
    }

    /*
     * If recording is already in progress,
     * finalize it immediately.
     */
    if (
      this.freeAnswerPhase ===
      'recording'
    ) {
      return this.finalizeFreeAnswer();
    }

    /*
     * Otherwise start the final recording phase.
     * This also allows the operator to end a round
     * while the timer is paused.
     */
    return this.finishFreeAnswerActive();
  }

  podium() {
    this.clearAuto();

    this.state =
      'PODIUM';

    this.freeAnswerPhase = null;
    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    const payload =
      this.podiumPayload();

    this.bus.gameOver(
      payload
    );

    const { ranks } =
      rankPlayers(
        this.connected()
      );

    for (
      const p of this.connected()
    ) {
      if (p.socketId) {
        this.bus.personalRank(
          p,
          {
            rank:
              ranks.get(
                p.token
              ),

            score:
              p.score,

            phase:
              'podium'
          }
        );
      }
    }
  }

  podiumPayload() {
    const { list, ranks } =
      rankPlayers(
        this.connected()
      );

    const standings =
      list.map(p => ({
        rank:
          ranks.get(
            p.token
          ),

        nickname:
          p.nickname,

        score:
          p.score
      }));

    return {
      podium:
        standings.slice(
          0,
          3
        ),

      standings
    };
  }

  endGame() {
    if (
      this.state === 'PODIUM' ||
      this.state === 'LOBBY'
    ) {
      return;
    }

    this.podium();
  }

  newGame() {
    if (
      this.state !==
      'PODIUM'
    ) {
      return;
    }

    this.state =
      'LOBBY';

    this.order = [];
    this.idx = -1;
    this.current = null;

    this.freeAnswerPhase = null;
    this.freeAnswerPhaseStart = 0;
    this.freeAnswerPhaseLimit = 0;
    this.freeAnswerSubQuestion = 0;

    this.freeAnswerPauseReason = null;
    this.freeAnswerRemainingMs = null;

    this.freeAnswerResults =
      new Map();

    this.bus.stateChange(
      'LOBBY'
    );

    this.bus.playersChanged({});
  }

  // ---- snapshots for reconnecting clients ----

  presenterSnapshot() {
    const snap = {
      state:
        this.state,

      pin:
        this.pin,

      players:
        this.connected()
          .sort(
            (a, b) =>
              a.joinedAt -
              b.joinedAt
          )
          .map(p => ({
            nickname:
              p.nickname
          })),

      sound:
        this.settings().sound,

      accent:
        this.settings().accent
    };

    if (
      this.state ===
        'QUESTION_ACTIVE' &&
      this.current
    ) {
      snap.question =
        this.questionStartPayload(
          this.freeAnswerPhase ===
            'paused'
            ? 0
            : Date.now() -
              this.freeAnswerPhaseStart
        );

      snap.answered =
        this.answeredCount();
    } else if (
      this.state ===
      'LEADERBOARD'
    ) {
      snap.leaderboard =
        this.leaderboardPayload();
    } else if (
      this.state ===
      'PODIUM'
    ) {
      snap.podium =
        this.podiumPayload();
    }

    return snap;
  }

  adminSnapshot() {
    const { ranks } =
      rankPlayers([
        ...this.players.values()
      ]);

    return {
      state:
        this.state,

      pin:
        this.pin,

      freeAnswerGame:
        this.freeAnswerGame,

      qNum:
        this.idx + 1,

      qTotal:
        this.order.length,

      currentIndex:
        this.idx,

      currentQuestion:
        this.current
          ? {
              roundNumber:
                this.current
                  .roundNumber,

              questionNumber:
                this.current
                  .questionNumber,

              type:
                this.current.type
            }
          : null,

      freeAnswerPhase:
        this.freeAnswerPhase,

      freeAnswerSubQuestion:
        this.freeAnswerSubQuestion,

      freeAnswerPhaseStart:
        this.freeAnswerPhaseStart,

      freeAnswerPhaseLimit:
        this.freeAnswerPhaseLimit,

      freeAnswerPauseReason:
        this.freeAnswerPauseReason,

      freeAnswerRemainingMs:
        this.freeAnswerRemainingMs,

      players:
        [...this.players.values()]
          .sort(
            (a, b) =>
              b.score -
                a.score ||
              a.joinedAt -
                b.joinedAt
          )
          .map(p => ({
            token:
              p.token,

            nickname:
              p.nickname,

            score:
              p.score,

            connected:
              p.connected,

            answered:
              !!p.current,

            rank:
              ranks.get(
                p.token
              )
          })),

      connectedCount:
        this.connected()
          .length,

      settings:
        this.settings(),

      freeAnswerGrading:
        this.state ===
          'REVEAL' ||
        this.state ===
          'LEADERBOARD'
          ? this.freeAnswerGradingSnapshot()
          : []
    };
  }

  playerSnapshot(p) {
    const snap = {
      token:
        p.token,

      nickname:
        p.nickname,

      state:
        this.state,

      score:
        p.score,

      playerCount:
        this.connected()
          .length,

      eligibleFrom:
        p.eligibleFrom,

      currentIndex:
        this.idx,

      sound:
        this.settings().sound,

      accent:
        this.settings().accent
    };

    const { ranks } =
      rankPlayers(
        this.connected()
      );

    snap.rank =
      ranks.get(
        p.token
      ) || null;

    const eligibleNow =
      p.eligibleFrom <=
      this.idx;

    if (
      this.state ===
        'QUESTION_ACTIVE' &&
      this.current &&
      eligibleNow
    ) {
      snap.question =
        this.questionStartPayload(
          this.freeAnswerPhase ===
            'paused'
            ? 0
            : Date.now() -
              this.freeAnswerPhaseStart
        );

      snap.freeAnswer = {
        locked:
          !!p.current,

        answer:
          p.current?.answer ??
          p.freeAnswerDraft ??
          ''
      };
    }

    return snap;
  }
}

module.exports = {
  GameSession
};