const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 6660;
const HOST = '0.0.0.0';

/* ============ HTTP 服务器：提供静态页面 ============ */
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

/* ============ 全局状态 ============ */

// gameId -> GameSession
const games = new Map();
// playerId -> gameId（快速查找玩家所在对局）
const playerToGame = new Map();
// playerId -> ws（正在等待配对的玩家）
const waitingPlayers = new Map();
// playerId -> ws（当前活跃 WebSocket 连接）
const playerSockets = new Map();

/* ============ 游戏会话 ============ */

class GameSession {
  constructor(playerA, playerB) {
    this.id = `${playerA}_${playerB}_${Date.now()}`;
    this.players = [playerA, playerB];
    this.hands = {};               // { playerId: [card, ...] }
    this.currentTurn = null;       // 当前轮到的玩家 ID
    this.lastPlay = null;          // 最后一次出牌列表
    this.lastPlayPlayer = null;    // 最后一次出牌的玩家
    this.winner = null;            // 胜者 ID
    this.online = { [playerA]: false, [playerB]: false };
    this.phase = 'WAITING';        // WAITING | PLAYING | GAME_OVER
    this.dealRequests = new Set();
    this.continueRequests = new Set();
  }

  opponent(playerId) {
    return this.players.find(p => p !== playerId);
  }

  bothOnline() {
    return this.players.every(p => this.online[p]);
  }

  bothOffline() {
    return this.players.every(p => !this.online[p]);
  }
}

/* ============ 牌组工具 ============ */

function createDeck() {
  const suits = ['♠', '♥', '♣', '♦'];
  const values = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
  const deck = [];
  let id = 0;
  for (const suit of suits) {
    for (const val of values) {
      const color = (suit === '♥' || suit === '♦') ? 'color-red' : 'color-black';
      deck.push({ id: id++, val, suit, color });
    }
  }
  deck.push({ id: id++, val: '小', suit: '🃏', color: 'color-black' });
  deck.push({ id: id++, val: '大', suit: '🃏', color: 'color-red' });
  return deck;
}

function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealCards(playerIds) {
  const deck = shuffleDeck(createDeck());
  // 随机移除 15 张（双人斗地主共 54 张，每人 18 张，剩 18 张不用）
  const removed = new Set();
  while (removed.size < 15) {
    removed.add(Math.floor(Math.random() * deck.length));
  }
  const remaining = deck.filter((_, i) => !removed.has(i));
  const hands = {};
  playerIds.forEach((id, i) => {
    hands[id] = remaining.slice(i * 18, (i + 1) * 18);
  });
  const firstTurn = playerIds[Math.floor(Math.random() * playerIds.length)];
  return { hands, firstTurn };
}

/* ============ 通信工具 ============ */

function sendTo(playerId, msg) {
  const ws = playerSockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(game, msg) {
  for (const pid of game.players) {
    sendTo(pid, msg);
  }
}

function sendOnlineStatus(game) {
  const onlineIds = game.players.filter(p => game.online[p]);
  broadcast(game, {
    type: 'online_count',
    count: onlineIds.length,
    players: onlineIds
  });
}

/* ============ 游戏管理 ============ */

function getGame(playerId) {
  const gid = playerToGame.get(playerId);
  return gid ? games.get(gid) : null;
}

function createGame(a, b) {
  const g = new GameSession(a, b);
  games.set(g.id, g);
  playerToGame.set(a, g.id);
  playerToGame.set(b, g.id);
  return g;
}

function removeGame(game) {
  for (const pid of game.players) {
    playerToGame.delete(pid);
  }
  games.delete(game.id);
}

function startDeal(game) {
  const { hands, firstTurn } = dealCards(game.players);
  game.hands = hands;
  game.currentTurn = firstTurn;
  game.lastPlay = null;
  game.lastPlayPlayer = null;
  game.winner = null;
  game.phase = 'PLAYING';
  game.dealRequests.clear();
  game.continueRequests.clear();

  // 分别给每位玩家发送其手牌（不泄露对方手牌）
  for (const pid of game.players) {
    sendTo(pid, {
      type: 'deal_result',
      hands: { [pid]: hands[pid] },
      firstTurn
    });
  }
}

/* ============ 玩家连接 / 断开 ============ */

function onJoin(ws, playerId) {
  // 若同一玩家已有旧连接，替换之（防止重复连接）
  const oldWs = playerSockets.get(playerId);
  if (oldWs && oldWs !== ws) {
    oldWs.playerId = null; // 标记为已废弃，close 事件不会再处理
    try { oldWs.close(); } catch (_) {}
  }

  ws.playerId = playerId;
  playerSockets.set(playerId, ws);

  // 检查是否已有对局（断线重连场景）
  const game = getGame(playerId);
  if (game) {
    restorePlayer(playerId, game);
    return;
  }

  // 尝试与等待中的玩家配对
  for (const [waitingId, waitingWs] of waitingPlayers) {
    if (waitingId !== playerId && waitingWs.readyState === WebSocket.OPEN) {
      waitingPlayers.delete(waitingId);
      const g = createGame(playerId, waitingId);
      g.online[playerId] = true;
      g.online[waitingId] = true;
      sendTo(playerId, { type: 'paired' });
      sendTo(waitingId, { type: 'paired' });
      sendOnlineStatus(g);
      return;
    }
  }

  // 暂无对手，进入等待队列
  waitingPlayers.set(playerId, ws);
  sendTo(playerId, { type: 'waiting' });
}

function restorePlayer(playerId, game) {
  game.online[playerId] = true;
  const opp = game.opponent(playerId);

  // 通知对手：对方已重连
  if (opp && game.online[opp]) {
    sendTo(opp, { type: 'opponent_reconnect', id: playerId });
  }

  // 广播在线状态
  sendOnlineStatus(game);

  if (game.phase === 'PLAYING' && game.hands[playerId]) {
    // 对局进行中：发送手牌 + 当前轮次 + 对手剩余牌数
    sendTo(playerId, {
      type: 'deal_result',
      hands: { [playerId]: game.hands[playerId] },
      firstTurn: game.currentTurn,
      isRestore: true,
      opponentCount: game.hands[opp] ? game.hands[opp].length : 0
    });

    // 恢复最后一次出牌展示
    if (game.lastPlay && game.lastPlay.length > 0) {
      sendTo(playerId, { type: 'restore_last_play', cards: game.lastPlay });
    }
  } else if (game.phase === 'GAME_OVER') {
    // 对局已结束：恢复结算界面
    sendTo(playerId, { type: 'game_over', winner: game.winner });

    // 若对手已点继续，同步状态
    if (opp && game.continueRequests.has(opp)) {
      sendTo(playerId, { type: 'continue', id: opp });
    }
  } else {
    // WAITING 阶段：通知配对，让客户端发起 deal_request
    sendTo(playerId, { type: 'paired' });
  }
}

function onDisconnect(ws) {
  const pid = ws.playerId;
  if (!pid) return; // 已被废弃的旧连接，忽略

  waitingPlayers.delete(pid);

  // 仅当当前映射的 socket 就是断开的这个时才清理
  if (playerSockets.get(pid) !== ws) return;
  playerSockets.delete(pid);

  const game = getGame(pid);
  if (!game) return;

  game.online[pid] = false;

  const opp = game.opponent(pid);
  if (opp) {
    sendTo(opp, { type: 'leave', id: pid });
  }
  sendOnlineStatus(game);

  // 双方都下线 → 删除对局
  if (game.bothOffline()) {
    removeGame(game);
  }
}

/* ============ 消息处理 ============ */

function onDealRequest(pid) {
  const g = getGame(pid);
  if (!g) return;

  g.dealRequests.add(pid);

  // 通知对手：对方已准备
  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'deal_request', id: pid });

  // 双方都已准备且都在线 → 发牌
  if (g.dealRequests.size >= 2 && g.bothOnline()) {
    startDeal(g);
  }
}

function onPlay(pid, cards) {
  const g = getGame(pid);
  if (!g) return;

  // 记录出牌状态
  g.lastPlay = cards;
  g.lastPlayPlayer = pid;
  g.currentTurn = g.opponent(pid);

  // 【关键修复】从服务器维护的手牌中移除已出的牌
  if (g.hands[pid]) {
    const playedIds = new Set(cards.map(c => c.id));
    g.hands[pid] = g.hands[pid].filter(c => !playedIds.has(c.id));
  }

  // 仅转发给对手（出牌方已在客户端本地处理）
  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'play', id: pid, cards });
}

function onPass(pid) {
  const g = getGame(pid);
  if (!g) return;

  g.currentTurn = g.opponent(pid);

  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'pass', id: pid });
}

function onRecall(pid) {
  const g = getGame(pid);
  if (!g) return;

  if (g.lastPlay && g.lastPlayPlayer) {
    const target = g.lastPlayPlayer;
    const cards = g.lastPlay;

    // 将牌还给出牌方
    if (!g.hands[target]) g.hands[target] = [];
    g.hands[target].push(...cards);

    g.lastPlay = null;
    g.lastPlayPlayer = null;
    g.currentTurn = target;

    broadcast(g, {
      type: 'recall_result',
      player: target,
      cards,
      nextTurn: target
    });
  } else {
    sendTo(pid, { type: 'recall_failed', message: '当前无牌可撤回' });
  }
}

function onGameOver(pid, winner) {
  const g = getGame(pid);
  if (!g) return;

  g.phase = 'GAME_OVER';
  g.winner = winner;

  broadcast(g, { type: 'game_over', winner });
}

function onContinue(pid) {
  const g = getGame(pid);
  if (!g) return;

  g.continueRequests.add(pid);

  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'continue', id: pid });

  // 双方都点继续 → 重新发牌
  if (g.continueRequests.size >= 2) {
    startDeal(g);
  }
}

function onReqRestart(pid) {
  const g = getGame(pid);
  if (!g) return;
  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'req_restart', id: pid });
}

function onRespRestart(pid, agree) {
  const g = getGame(pid);
  if (!g) return;

  const opp = g.opponent(pid);
  if (opp) sendTo(opp, { type: 'resp_restart', agree, id: pid });

  if (agree) {
    // 重置对局状态，等待双方重新 deal_request
    g.phase = 'WAITING';
    g.dealRequests.clear();
    g.continueRequests.clear();
    g.hands = {};
    g.lastPlay = null;
    g.lastPlayPlayer = null;
    g.winner = null;
  }
}

/* ============ WebSocket 连接 ============ */

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const pid = msg.id;

      switch (msg.type) {
        case 'join':           onJoin(ws, pid); break;
        case 'deal_request':   onDealRequest(pid); break;
        case 'play':           onPlay(pid, msg.cards); break;
        case 'pass':           onPass(pid); break;
        case 'recall_request': onRecall(pid); break;
        case 'game_over':      onGameOver(pid, msg.winner); break;
        case 'continue':       onContinue(pid); break;
        case 'req_restart':    onReqRestart(pid); break;
        case 'resp_restart':   onRespRestart(pid, msg.agree); break;
        case 'ping':           ws.send(JSON.stringify({ type: 'pong' })); break;
      }
    } catch (e) {}
  });

  ws.on('close', () => onDisconnect(ws));
  ws.on('error', (e) => {});
});

server.listen(PORT, HOST, () => {});