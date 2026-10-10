// server.js  — النسخة المحدّثة (خيارات التوقيت + تجميع بيانات اللوج لإرسالها للعميل)
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
const QUESTION_COUNTS = [10, 15, 20];
const TIME_LIMITS = [0, 10, 15, 20, 30];   // 0 = بدون وقت (مفتوح)
const DEFAULT_TIME_LIMIT = 15;
const NEXT_QUESTION_DELAY = 3500;          // ms
const GRACE_MS = 300;                      // سماح بسيط لتأخر الشبكة عند نهاية الوقت
const MAX_STREAK_BONUS_STEPS = 5;          // الكومبو يصل +50% كحد أقصى
const ROOM_CODE_LENGTH = 5;

/* ============================================================
   IN-MEMORY STATE
============================================================ */
// rooms[code] = {
//   code, hostId, settings: {ops, difficulty, mode, questionCount, timeLimit},
//   players: Map(socketId -> {id, profileId, name, tag, score, streak, bestStreak, correct, wrong, connected, answeredThisRound}),
//   state: 'lobby' | 'playing' | 'finished',
//   questionIndex, currentQuestion, questionTimer, nextTimer, startedAt,
//   log: { questions: [{ text, correct, timeLimit, answers: { [profileId]: {answer, time, ok} } }] }
// }
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
function cleanStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
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
   - نقاط أساسية حسب الصعوبة
   - مكافأة سرعة (فقط إذا كان هناك وقت محدد)
   - مضاعف كومبو
============================================================ */
function calcPoints(difficulty, elapsedMs, streakBefore, timeLimitSec) {
  const base = DIFFICULTY_BASE_POINTS[difficulty] || 10;
  let speedBonus = 0;
  if (timeLimitSec > 0) {
    const timeLimitMs = timeLimitSec * 1000;
    const remainingRatio = Math.max(0, (timeLimitMs - elapsedMs) / timeLimitMs);
    speedBonus = Math.round(base * remainingRatio);
  }
  const comboSteps = Math.min(streakBefore, MAX_STREAK_BONUS_STEPS);
  const comboMultiplier = 1 + comboSteps * 0.1;
  return Math.round((base + speedBonus) * comboMultiplier);
}

/* ============================================================
   ROOM / PLAYER HELPERS
============================================================ */
function createPlayer(socketId, ident) {
  return {
    id: socketId,
    profileId: ident.profileId,
    name: ident.name,
    tag: ident.tag,
    score: 0, streak: 0, bestStreak: 0, correct: 0, wrong: 0,
    connected: true,
    answeredThisRound: false
  };
}

function getPublicPlayers(room) {
  return [...room.players.values()]
    .map(p => ({
      id: p.id,
      name: p.name,
      tag: p.tag,
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

function readIdentity(data) {
  const profileId = cleanStr(data && data.profileId, 64);
  if (!profileId) return null;
  const name = cleanStr(data.playerName, 20).replace(/#/g, '').trim() || 'لاعب';
  const tag = cleanStr(data.tag, 16).replace(/^#+/, '').toLowerCase();
  return { profileId, name, tag };
}

/* ============================================================
   GAME FLOW
============================================================ */
function startGame(room) {
  clearTimeout(room.questionTimer);
  clearTimeout(room.nextTimer);

  // إزالة اللاعبين المنقطعين قبل بدء جولة جديدة
  [...room.players.values()].forEach(p => { if (!p.connected) room.players.delete(p.id); });

  room.state = 'playing';
  room.questionIndex = 0;
  room.currentQuestion = null;
  room.startedAt = Date.now();
  room.log = { questions: [] };
  room.players.forEach(p => {
    p.score = 0; p.streak = 0; p.bestStreak = 0; p.correct = 0; p.wrong = 0; p.answeredThisRound = false;
  });
  io.to(room.code).emit('game_started');
  askNextQuestion(room);
}

function askNextQuestion(room) {
  if (room.state !== 'playing') return;
  const total = room.settings.questionCount;
  if (room.questionIndex >= total) {
    return finishGame(room);
  }
  room.questionIndex++;

  const q = generateQuestion(room.settings.ops, room.settings.difficulty, room.settings.mode);
  const timeLimit = room.settings.timeLimit;
  const logEntry = { text: q.exprHTML, correct: q.answer, timeLimit, answers: {} };
  room.log.questions.push(logEntry);

  room.currentQuestion = { ...q, startTime: Date.now(), logEntry, ended: false };
  room.players.forEach(p => { p.answeredThisRound = false; });

  io.to(room.code).emit('new_question', {
    questionNumber: room.questionIndex,
    totalQuestions: total,
    opKey: q.opKey,
    opLabel: q.opLabel,
    exprHTML: q.exprHTML,
    choices: q.choices,
    mode: room.settings.mode,
    timeLimit,                          // 0 = بدون وقت
    startTime: room.currentQuestion.startTime
  });
  broadcastRoom(room);

  clearTimeout(room.questionTimer);
  if (timeLimit > 0) {
    room.questionTimer = setTimeout(() => endQuestion(room), timeLimit * 1000 + GRACE_MS);
  }
}

// من لم يجب يُحتسب خاطئًا ويُكسر كومبوه
function finalizeQuestion(room) {
  room.players.forEach(p => {
    if (!p.answeredThisRound) {
      p.answeredThisRound = true;
      p.streak = 0;
      p.wrong += 1;
    }
  });
}

function endQuestion(room) {
  const cq = room.currentQuestion;
  if (room.state !== 'playing' || !cq || cq.ended) return;
  cq.ended = true;
  clearTimeout(room.questionTimer);
  finalizeQuestion(room);

  io.to(room.code).emit('question_ended', {
    correctAnswer: cq.answer,
    leaderboard: getPublicPlayers(room)
  });

  clearTimeout(room.nextTimer);
  room.nextTimer = setTimeout(() => {
    if (room.state === 'playing') askNextQuestion(room);
  }, NEXT_QUESTION_DELAY);
}

function maybeEndQuestionEarly(room) {
  const cq = room.currentQuestion;
  if (!cq || cq.ended) return;
  const allAnswered = [...room.players.values()]
    .filter(p => p.connected)
    .every(p => p.answeredThisRound);
  if (allAnswered && connectedPlayerCount(room) > 0) {
    endQuestion(room);
  }
}

function pickLogger(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return room.hostId;
  const any = [...room.players.values()].find(p => p.connected);
  return any ? any.id : null;
}

function buildMatchLog(room) {
  const players = [...room.players.values()]
    .map(p => ({
      id: p.profileId, name: p.name, tag: p.tag,
      score: p.score, correct: p.correct, wrong: p.wrong, bestStreak: p.bestStreak
    }))
    .sort((a, b) => b.score - a.score);

  return {
    ts: room.startedAt,
    roomName: room.code,
    roomSize: room.settings.questionCount,
    timeLimit: room.settings.timeLimit,
    ops: room.settings.ops,
    difficulty: room.settings.difficulty,
    mode: room.settings.mode,
    players,
    questions: room.log.questions
  };
}

function finishGame(room) {
  if (room.state !== 'playing') return;
  clearTimeout(room.questionTimer);
  clearTimeout(room.nextTimer);

  // سؤال لم ينتهِ بعد (إنهاء مبكر من المضيف)
  const cq = room.currentQuestion;
  if (cq && !cq.ended) {
    if (Object.keys(cq.logEntry.answers).length === 0) {
      room.log.questions.pop();          // لم يجب أحد → لا يُحتسب
    } else {
      finalizeQuestion(room);
    }
    cq.ended = true;
  }

  room.state = 'finished';
  io.to(room.code).emit('game_over', {
    leaderboard: getPublicPlayers(room),
    matchLog: buildMatchLog(room),
    loggerId: pickLogger(room)           // العميل الوحيد المسؤول عن كتابة اللوج في Firebase
  });
}

/* ============================================================
   SOCKET HANDLERS
============================================================ */
io.on('connection', (socket) => {

  socket.on('create_room', (data) => {
    const ident = readIdentity(data);
    const cleanSettings = sanitizeSettings(data && data.settings);
    if (!ident) { socket.emit('room_error', { message: 'بيانات الحساب مفقودة' }); return; }
    if (!cleanSettings) { socket.emit('room_error', { message: 'إعدادات غير صالحة' }); return; }

    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      settings: cleanSettings,
      players: new Map(),
      state: 'lobby',
      questionIndex: 0,
      currentQuestion: null,
      questionTimer: null,
      nextTimer: null,
      startedAt: 0,
      log: { questions: [] }
    };
    room.players.set(socket.id, createPlayer(socket.id, ident));
    rooms[code] = room;

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('room_created', roomSummary(room));
    broadcastRoom(room);
  });

  socket.on('join_room', (data) => {
    const ident = readIdentity(data);
    if (!ident) { socket.emit('room_error', { message: 'بيانات الحساب مفقودة' }); return; }

    const code = cleanStr(data && data.roomCode, 10).toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('room_error', { message: 'رمز الغرفة غير صحيح' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('room_error', { message: 'اللعبة بدأت بالفعل في هذه الغرفة' });
      return;
    }
    if ([...room.players.values()].some(p => p.profileId === ident.profileId)) {
      socket.emit('room_error', { message: 'هذا الحساب موجود بالفعل في الغرفة' });
      return;
    }

    room.players.set(socket.id, createPlayer(socket.id, ident));
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('room_joined', roomSummary(room));
    broadcastRoom(room);
  });

  socket.on('start_game', ({ roomCode } = {}) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('room_error', { message: 'فقط منشئ الغرفة يمكنه بدء اللعبة' });
      return;
    }
    if (room.state === 'playing') return;   // يسمح من 'lobby' أو 'finished'
    startGame(room);
  });

  socket.on('submit_answer', ({ roomCode, answer } = {}) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing' || !room.currentQuestion) return;
    const cq = room.currentQuestion;
    const player = room.players.get(socket.id);
    if (!player || player.answeredThisRound || cq.ended) return;

    const elapsedMs = Date.now() - cq.startTime;
    const limitMs = room.settings.timeLimit * 1000;
    const onTime = limitMs === 0 || elapsedMs <= limitMs + GRACE_MS;

    const raw = cleanStr(answer, 20);
    const num = Number(raw);
    const answerVal = (raw !== '' && Number.isFinite(num)) ? num : raw;
    const isCorrect = onTime && typeof answerVal === 'number' && answerVal === cq.answer;

    player.answeredThisRound = true;
    let pointsEarned = 0;
    if (isCorrect) {
      pointsEarned = calcPoints(room.settings.difficulty, elapsedMs, player.streak, room.settings.timeLimit);
      player.streak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      player.correct += 1;
      player.score += pointsEarned;
    } else {
      player.streak = 0;
      player.wrong += 1;
    }

    // تسجيل الإجابة والوقت المستغرق (بالثواني) لهذا اللاعب
    cq.logEntry.answers[player.profileId] = {
      answer: answerVal,
      time: Math.round(elapsedMs / 100) / 10,
      ok: isCorrect
    };

    socket.emit('answer_result', {
      correct: isCorrect,
      pointsEarned,
      totalScore: player.score,
      streak: player.streak
    });

    broadcastRoom(room);
    maybeEndQuestionEarly(room);
  });

  // المضيف يتخطى السؤال (مفيد في وضع "بدون وقت")
  socket.on('skip_question', ({ roomCode } = {}) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId || room.state !== 'playing') return;
    endQuestion(room);
  });

  socket.on('end_game', ({ roomCode } = {}) => {
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

  if (explicitLeave) socket.leave(code);

  if (explicitLeave || room.state === 'lobby') {
    room.players.delete(socket.id);
  } else {
    player.connected = false;
  }
  if (explicitLeave) socket.data.roomCode = null;

  if (room.hostId === socket.id) {
    const nextHost = [...room.players.values()].find(p => p.connected);
    room.hostId = nextHost ? nextHost.id : null;
  }

  if (room.players.size === 0 || connectedPlayerCount(room) === 0) {
    clearTimeout(room.questionTimer);
    clearTimeout(room.nextTimer);
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
  if (!QUESTION_COUNTS.includes(questionCount)) questionCount = 10;

  let timeLimit = parseInt(settings.timeLimit, 10);
  if (!TIME_LIMITS.includes(timeLimit)) timeLimit = DEFAULT_TIME_LIMIT;

  return { ops: [...new Set(ops)], difficulty, mode, questionCount, timeLimit };
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});