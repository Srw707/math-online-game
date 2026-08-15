// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   GAME CONFIG
============================================================ */
const OP_LABELS = {
  add: 'جمع',
  sub: 'طرح',
  mul: 'ضرب',
  div: 'قسمة',
  root: 'الجذر التربيعي',
  pow: 'الأس'
};

const DIFFICULTY_BASE_POINTS = { easy: 10, medium: 20, hard: 30 };
const QUESTION_TIME_LIMIT = 15;       // seconds each player has to answer
const NEXT_QUESTION_DELAY = 3500;     // ms pause between questions to show results
const MAX_STREAK_BONUS_STEPS = 5;     // combo caps at +50% (5 * 10%)
const ROOM_CODE_LENGTH = 5;

/* ============================================================
   IN-MEMORY STATE
============================================================ */
// rooms[code] = {
//   code, hostId, settings: {ops, difficulty, mode, questionCount},
//   players: Map(socketId -> {id, name, score, streak, bestStreak, connected, answeredThisRound}),
//   state: 'lobby' | 'playing' | 'finished',
//   questionIndex, currentQuestion, questionTimer
// }
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]);
  return code;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ============================================================
   QUESTION GENERATION (server authoritative)
============================================================ */
function generateQuestion(opsList, difficulty, mode) {
  const opKey = pick(opsList);
  const d = difficulty;
  let a, b, answer, exprHTML, exponent;

  switch (opKey) {
    case 'add': {
      const range = d === 'easy' ? [1, 20] : d === 'medium' ? [10, 100] : [100, 999];
      a = randInt(...range); b = randInt(...range);
      answer = a + b;
      exprHTML = `${a} + ${b}`;
      break;
    }
    case 'sub': {
      const range = d === 'easy' ? [1, 20] : d === 'medium' ? [10, 100] : [100, 999];
      a = randInt(...range); b = randInt(...range);
      if (b > a) [a, b] = [b, a];
      answer = a - b;
      exprHTML = `${a} − ${b}`;
      break;
    }
    case 'mul': {
      const rA = d === 'easy' ? [1, 10] : d === 'medium' ? [2, 20] : [10, 99];
      const rB = d === 'easy' ? [1, 10] : d === 'medium' ? [2, 12] : [10, 30];
      a = randInt(...rA); b = randInt(...rB);
      answer = a * b;
      exprHTML = `${a} × ${b}`;
      break;
    }
    case 'div': {
      const rDiv = d === 'easy' ? [1, 10] : d === 'medium' ? [2, 12] : [5, 25];
      const rQuot = d === 'easy' ? [1, 10] : d === 'medium' ? [2, 20] : [5, 30];
      b = randInt(...rDiv);
      const q = randInt(...rQuot);
      a = b * q; answer = q;
      exprHTML = `${a} ÷ ${b}`;
      break;
    }
    case 'root': {
      const rQ = d === 'easy' ? [1, 10] : d === 'medium' ? [1, 15] : [10, 30];
      const q = randInt(...rQ);
      a = q * q; answer = q;
      exprHTML = `√${a}`;
      break;
    }
    case 'pow': {
      exponent = d === 'easy' ? 2 : (Math.random() < 0.7 ? 2 : 3);
      const rBase = d === 'easy' ? [1, 5] : d === 'medium' ? [2, 9] : [2, 12];
      a = randInt(...rBase);
      answer = Math.pow(a, exponent);
      exprHTML = `${a}^${exponent}`;
      break;
    }
  }

  let choices = null;
  if (mode === 'choice') {
    const set = new Set([answer]);
    const spread = Math.max(2, Math.round(Math.abs(answer) * 0.18) + 1);
    let guard = 0;
    while (set.size < 4 && guard < 100) {
      guard++;
      const delta = randInt(-spread, spread) || 1;
      const cand = answer + delta;
      if (cand >= 0 && !set.has(cand)) set.add(cand);
    }
    choices = [...set];
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
  }

  return { opKey, opLabel: OP_LABELS[opKey], exprHTML, answer, choices };
}

/* ============================================================
   SCORING
============================================================ */
function calcPoints(difficulty, elapsedMs, streak) {
  const base = DIFFICULTY_BASE_POINTS[difficulty] || 10;
  const timeLimitMs = QUESTION_TIME_LIMIT * 1000;
  const remainingRatio = Math.max(0, (timeLimitMs - elapsedMs) / timeLimitMs);
  const speedBonus = Math.round(base * remainingRatio); // up to +100% for instant answers
  const comboSteps = Math.min(streak, MAX_STREAK_BONUS_STEPS);
  const comboMultiplier = 1 + comboSteps * 0.1;
  return Math.round((base + speedBonus) * comboMultiplier);
}

/* ============================================================
   ROOM / PLAYER HELPERS
============================================================ */
function getPublicPlayers(room) {
  return [...room.players.values()]
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      streak: p.streak,
      bestStreak: p.bestStreak,
      connected: p.connected,
      isHost: p.id === room.hostId,
      answeredThisRound: !!p.answeredThisRound
    }))
    .sort((x, y) => y.score - x.score);
}

function roomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    state: room.state,
    players: getPublicPlayers(room)
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', roomSummary(room));
}

function connectedPlayerCount(room) {
  return [...room.players.values()].filter(p => p.connected).length;
}

/* ============================================================
   GAME FLOW
============================================================ */
function startGame(room) {
  room.state = 'playing';
  room.questionIndex = 0;
  room.players.forEach(p => { p.score = 0; p.streak = 0; p.bestStreak = 0; });
  io.to(room.code).emit('game_started');
  askNextQuestion(room);
}

function askNextQuestion(room) {
  const total = room.settings.questionCount;
  if (room.questionIndex >= total) {
    return finishGame(room);
  }
  room.questionIndex++;

  const q = generateQuestion(room.settings.ops, room.settings.difficulty, room.settings.mode);
  room.currentQuestion = { ...q, startTime: Date.now() };
  room.players.forEach(p => { p.answeredThisRound = false; });

  const payload = {
    questionNumber: room.questionIndex,
    totalQuestions: total,
    opKey: q.opKey,
    opLabel: q.opLabel,
    exprHTML: q.exprHTML,
    choices: q.choices,
    mode: room.settings.mode,
    timeLimit: QUESTION_TIME_LIMIT,
    startTime: room.currentQuestion.startTime
  };
  io.to(room.code).emit('new_question', payload);
  broadcastRoom(room);

  clearTimeout(room.questionTimer);
  room.questionTimer = setTimeout(() => endQuestion(room), QUESTION_TIME_LIMIT * 1000 + 300);
}

function endQuestion(room) {
  if (!room.currentQuestion || room.currentQuestion.ended) return;
  room.currentQuestion.ended = true;
  clearTimeout(room.questionTimer);

  io.to(room.code).emit('question_ended', {
    correctAnswer: room.currentQuestion.answer,
    leaderboard: getPublicPlayers(room)
  });

  setTimeout(() => {
    if (room.state === 'playing') askNextQuestion(room);
  }, NEXT_QUESTION_DELAY);
}

function maybeEndQuestionEarly(room) {
  if (!room.currentQuestion || room.currentQuestion.ended) return;
  const allAnswered = [...room.players.values()]
    .filter(p => p.connected)
    .every(p => p.answeredThisRound);
  if (allAnswered && connectedPlayerCount(room) > 0) {
    endQuestion(room);
  }
}

function finishGame(room) {
  room.state = 'finished';
  clearTimeout(room.questionTimer);
  io.to(room.code).emit('game_over', {
    leaderboard: getPublicPlayers(room)
  });
}

/* ============================================================
   SOCKET HANDLERS
============================================================ */
io.on('connection', (socket) => {

  socket.on('create_room', ({ playerName, settings }) => {
    const name = (playerName || 'لاعب').toString().trim().slice(0, 20) || 'لاعب';
    const cleanSettings = sanitizeSettings(settings);
    if (!cleanSettings) {
      socket.emit('room_error', { message: 'إعدادات غير صالحة' });
      return;
    }

    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      settings: cleanSettings,
      players: new Map(),
      state: 'lobby',
      questionIndex: 0,
      currentQuestion: null,
      questionTimer: null
    };
    room.players.set(socket.id, {
      id: socket.id, name, score: 0, streak: 0, bestStreak: 0,
      connected: true, answeredThisRound: false
    });
    rooms[code] = room;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = name;

    socket.emit('room_created', roomSummary(room));
    broadcastRoom(room);
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = (roomCode || '').toString().trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('room_error', { message: 'رمز الغرفة غير صحيح' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('room_error', { message: 'اللعبة بدأت بالفعل في هذه الغرفة' });
      return;
    }
    const name = (playerName || 'لاعب').toString().trim().slice(0, 20) || 'لاعب';

    room.players.set(socket.id, {
      id: socket.id, name, score: 0, streak: 0, bestStreak: 0,
      connected: true, answeredThisRound: false
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = name;

    socket.emit('room_joined', roomSummary(room));
    broadcastRoom(room);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('room_error', { message: 'فقط منشئ الغرفة يمكنه بدء اللعبة' });
      return;
    }
    if (room.players.size < 1) return;
    if (room.state === 'playing') return; // allow restart from 'lobby' or 'finished'
    startGame(room);
  });

  socket.on('submit_answer', ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing' || !room.currentQuestion) return;
    const player = room.players.get(socket.id);
    if (!player || player.answeredThisRound || room.currentQuestion.ended) return;

    const elapsedMs = Date.now() - room.currentQuestion.startTime;
    const isCorrect = Number(answer) === room.currentQuestion.answer;

    player.answeredThisRound = true;
    let pointsEarned = 0;
    if (isCorrect && elapsedMs <= QUESTION_TIME_LIMIT * 1000) {
      player.streak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      pointsEarned = calcPoints(room.settings.difficulty, elapsedMs, player.streak - 1);
      player.score += pointsEarned;
    } else {
      player.streak = 0;
    }

    socket.emit('answer_result', {
      correct: isCorrect,
      correctAnswer: room.currentQuestion.answer,
      pointsEarned,
      totalScore: player.score,
      streak: player.streak
    });

    broadcastRoom(room);
    maybeEndQuestionEarly(room);
  });

  socket.on('end_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    finishGame(room);
  });

  socket.on('leave_room', () => {
    handleDisconnectOrLeave(socket, true);
  });

  socket.on('disconnect', () => {
    handleDisconnectOrLeave(socket, false);
  });
});

function handleDisconnectOrLeave(socket, explicitLeave) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms[code];
  if (!room) return;

  const player = room.players.get(socket.id);
  if (!player) return;

  if (explicitLeave || room.state === 'lobby') {
    room.players.delete(socket.id);
  } else {
    player.connected = false;
  }

  if (room.hostId === socket.id) {
    const nextHost = [...room.players.values()].find(p => p.connected);
    room.hostId = nextHost ? nextHost.id : null;
  }

  if (room.players.size === 0 || connectedPlayerCount(room) === 0) {
    clearTimeout(room.questionTimer);
    delete rooms[code];
    return;
  }

  broadcastRoom(room);
  if (room.state === 'playing') maybeEndQuestionEarly(room);
}

/* ============================================================
   SETTINGS VALIDATION
============================================================ */
function sanitizeSettings(settings) {
  if (!settings) return null;
  const validOps = Object.keys(OP_LABELS);
  const ops = Array.isArray(settings.ops) ? settings.ops.filter(o => validOps.includes(o)) : [];
  if (ops.length === 0) return null;

  const difficulty = ['easy', 'medium', 'hard'].includes(settings.difficulty) ? settings.difficulty : 'medium';
  const mode = ['type', 'choice'].includes(settings.mode) ? settings.mode : 'choice';
  let questionCount = parseInt(settings.questionCount, 10);
  if (!Number.isFinite(questionCount) || questionCount < 1) questionCount = 10;
  questionCount = Math.min(questionCount, 50);

  return { ops, difficulty, mode, questionCount };
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});