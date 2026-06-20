/**
 * 双人斗地主 - 后端服务器
 * - 日志全部写入 server_log.txt
 * - 新增撤回(recall)功能
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- 基础配置 ---
const PORT = process.env.PORT || 6660;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  try { urlPath = decodeURIComponent(urlPath); } catch (e) {}
  if (urlPath === '/') urlPath = '/index.html';

  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  if (filePath.indexOf(__dirname) !== 0) {
    res.writeHead(403); res.end('403 Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const clients = new Set();
const dealRequests = new Set();
const continueRequests = new Set();

let gameState = {
  hands: {},
  currentTurn: null,
  lastPlay: null,       // 最后一次出的牌
  lastPlayPlayer: null  // 最后一次出牌的玩家ID
};

function createDeck() {
  const suits = ['♠', '♥', '♣', '♦'];
  const values = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
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
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function dealCards() {
  const deck = shuffleDeck(createDeck());
  const removedCount = 15;
  const removedIndices = new Set();
  while (removedIndices.size < removedCount) {
    removedIndices.add(Math.floor(Math.random() * deck.length));
  }
  const remainingDeck = deck.filter((_, index) => !removedIndices.has(index));

  const playerIds = [];
  clients.forEach(client => {
    if (client.playerId) playerIds.push(client.playerId);
  });

  if (playerIds.length < 2) return null;

  const hands = {};
  const cardsPerPlayer = 18;
  playerIds.forEach((id, index) => {
    hands[id] = remainingDeck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer);
  });

  const firstTurn = playerIds[Math.floor(Math.random() * playerIds.length)];
  return { hands, firstTurn };
}

function broadcast(message) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

function handleDealRequest(clientId) {
  dealRequests.add(clientId);
  broadcast({ type: 'deal_request', id: clientId });

  if (dealRequests.size >= 2) {
    const result = dealCards();
    if (result) {
      gameState.hands = result.hands;
      gameState.currentTurn = result.firstTurn;
      gameState.lastPlay = null;
      gameState.lastPlayPlayer = null;
      
      broadcast({ type: 'deal_result', hands: result.hands, firstTurn: result.firstTurn });
      broadcast({ type: 'turn_change', isMyTurn: true, id: result.firstTurn });
      dealRequests.clear();
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'join':
          ws.playerId = msg.id;
          broadcast(msg);
          broadcast({ type: 'online_count', count: clients.size });
          break;

        case 'leave':
          broadcast(msg);
          break;

        case 'deal_request':
          handleDealRequest(msg.id);
          break;

        case 'play':
          gameState.lastPlay = msg.cards;
          gameState.lastPlayPlayer = msg.id;
          broadcast(msg);
          clients.forEach(client => {
            if (client.playerId !== msg.id && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'turn_change', isMyTurn: true, id: client.playerId }));
            }
          });
          break;

        case 'pass':
          // 注意：pass不清空lastPlay，因为对方可能还要继续压牌
          broadcast(msg);
          clients.forEach(client => {
            if (client.playerId !== msg.id && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'turn_change', isMyTurn: true, id: client.playerId }));
            }
          });
          break;

        case 'recall_request':
          // 处理撤回逻辑
          if (gameState.lastPlay && gameState.lastPlayPlayer) {
            const targetPlayer = gameState.lastPlayPlayer;
            const cardsToReturn = gameState.lastPlay;
            
            // 退还手牌
            if (!gameState.hands[targetPlayer]) gameState.hands[targetPlayer] = [];
            gameState.hands[targetPlayer].push(...cardsToReturn);
            
            // 清空出牌记录
            gameState.lastPlay = null;
            gameState.lastPlayPlayer = null;
            
            // 切换回合给被退还的玩家
            gameState.currentTurn = targetPlayer;
            
            // 广播撤回结果
            broadcast({
              type: 'recall_result',
              player: targetPlayer,
              cards: cardsToReturn,
              nextTurn: targetPlayer
            });
          } else {
            // 无牌可撤
            ws.send(JSON.stringify({ type: 'recall_failed', message: '当前无牌可撤回' }));
          }
          break;

        case 'game_over':
          broadcast({ type: 'game_over', winner: msg.winner });
          break;

        case 'continue':
          continueRequests.add(msg.id);
          broadcast(msg);
          if (continueRequests.size >= 2) {
            continueRequests.clear();
            dealRequests.clear();
            const result = dealCards();
            if (result) {
              gameState.hands = result.hands;
              gameState.currentTurn = result.firstTurn;
              gameState.lastPlay = null;
              gameState.lastPlayPlayer = null;
              broadcast({ type: 'deal_result', hands: result.hands, firstTurn: result.firstTurn });
              broadcast({ type: 'turn_change', isMyTurn: true, id: result.firstTurn });
            }
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          broadcast(msg);
      }
    } catch (e) {
      // 解析失败时忽略，保持原有结构
    }
  });

  ws.on('close', () => {
    if (ws.playerId) broadcast({ type: 'leave', id: ws.playerId });
    clients.delete(ws);
    dealRequests.delete(ws.playerId);
    continueRequests.delete(ws.playerId);
  });
});

server.listen(PORT, HOST);