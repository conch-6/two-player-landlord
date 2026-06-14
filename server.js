/**
 * 双人斗地主 - 后端服务器
 * 
 * 设计理念：
 * - 极简设计，服务器仅作为"复读机"
 * - 洗牌发牌逻辑写死在代码中
 * - 接收消息 -> 原样广播给所有客户端
 * 
 * 运行方式：node server.js
 * 默认端口：8080
 */

const WebSocket = require('ws');

// 配置
const PORT = process.env.PORT || 8080;

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ port: PORT });

// 存储所有连接的客户端
const clients = new Set();

// 存储发牌请求（用于检测双方是否都已请求）
const dealRequests = new Set();

// 存储继续请求（用于检测双方是否都想继续）
const continueRequests = new Set();

// 存储游戏状态
let gameState = {
    hands: {},      // { playerId: [cards] }
    currentTurn: null,
    lastPlay: null,
    lastPlayPlayer: null
};

console.log(`[服务器] 双人斗地主服务器启动，端口: ${PORT}`);

/**
 * 创建一副完整的扑克牌
 */
function createDeck() {
    const suits = ['♠', '♥', '♣', '♦'];
    const values = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const deck = [];
    
    let id = 0;
    
    // 普通牌
    for (const suit of suits) {
        for (const val of values) {
            const color = (suit === '♥' || suit === '♦') ? 'color-red' : 'color-black';
            deck.push({ id: id++, val, suit, color });
        }
    }
    
    // 大小王
    deck.push({ id: id++, val: '小', suit: '🃏', color: 'color-black' });
    deck.push({ id: id++, val: '大', suit: '🃏', color: 'color-red' });
    
    return deck;
}

/**
 * 洗牌（Fisher-Yates 算法）
 */
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * 发牌
 * 规则：随机移除15张牌，每人发18张
 */
function dealCards() {
    const deck = shuffleDeck(createDeck());
    
    // 随机移除15张牌
    const removedCount = 15;
    const removedIndices = new Set();
    while (removedIndices.size < removedCount) {
        removedIndices.add(Math.floor(Math.random() * deck.length));
    }
    
    const remainingDeck = deck.filter((_, index) => !removedIndices.has(index));
    
    // 获取所有已连接的玩家ID
    const playerIds = [];
    clients.forEach(client => {
        if (client.playerId) {
            playerIds.push(client.playerId);
        }
    });
    
    if (playerIds.length < 2) {
        console.log('[发牌] 玩家不足两人，无法发牌');
        return null;
    }
    
    // 发牌：每人18张
    const hands = {};
    const cardsPerPlayer = 18;
    
    playerIds.forEach((id, index) => {
        hands[id] = remainingDeck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer);
    });
    
    // 随机决定先手
    const firstTurn = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    console.log(`[发牌] 发牌完成，先手玩家: ${firstTurn}`);
    
    return { hands, firstTurn };
}

/**
 * 广播消息给所有客户端
 */
function broadcast(message) {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    console.log(`[广播] ${messageStr}`);
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

/**
 * 处理发牌请求
 */
function handleDealRequest(clientId) {
    dealRequests.add(clientId);
    console.log(`[发牌请求] 玩家 ${clientId} 请求发牌，当前请求数: ${dealRequests.size}`);
    
    // 广播发牌请求（让对手知道）
    broadcast({ type: 'deal_request', id: clientId });
    
    // 当有两个不同的玩家请求发牌时，执行发牌
    if (dealRequests.size >= 2) {
        const result = dealCards();
        if (result) {
            gameState.hands = result.hands;
            gameState.currentTurn = result.firstTurn;
            gameState.lastPlay = null;
            gameState.lastPlayPlayer = null;
            
            // 广播发牌结果
            broadcast({
                type: 'deal_result',
                hands: result.hands,
                firstTurn: result.firstTurn
            });
            
            // 通知先手玩家
            broadcast({
                type: 'turn_change',
                isMyTurn: true,
                id: result.firstTurn
            });
            
            // 清空发牌请求
            dealRequests.clear();
        }
    }
}

/**
 * 处理客户端连接
 */
wss.on('connection', (ws) => {
    console.log('[连接] 新客户端连接');
    clients.add(ws);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            console.log(`[收到] ${JSON.stringify(msg)}`);
            
            // 处理特殊消息类型
            switch (msg.type) {
                case 'join':
                    // 玩家加入
                    ws.playerId = msg.id;
                    console.log(`[加入] 玩家 ${msg.id} 加入游戏`);
                    // 广播加入消息
                    broadcast(msg);
                    // 广播当前在线人数
                    broadcast({ type: 'online_count', count: clients.size });
                    break;
                
                case 'leave':
                    // 玩家离开
                    console.log(`[离开] 玩家 ${ws.playerId} 离开游戏`);
                    broadcast(msg);
                    break;
                
                case 'deal_request':
                    // 发牌请求
                    handleDealRequest(msg.id);
                    break;
                
                case 'play':
                    // 出牌 - 记录并广播
                    gameState.lastPlay = msg.cards;
                    gameState.lastPlayPlayer = msg.id;
                    broadcast(msg);
                    
                    // 切换回合
                    clients.forEach(client => {
                        if (client.playerId !== msg.id && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'turn_change', isMyTurn: true, id: client.playerId }));
                        }
                    });
                    break;
                
                case 'pass':
                    // 不出 - 广播并切换回合
                    broadcast(msg);
                    clients.forEach(client => {
                        if (client.playerId !== msg.id && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'turn_change', isMyTurn: true, id: client.playerId }));
                        }
                    });
                    break;
                
                case 'game_over':
                    // 游戏结束
                    console.log(`[游戏结束] 玩家 ${msg.winner} 获胜`);
                    broadcast({ type: 'game_over', winner: msg.winner });
                    break;
                
                case 'continue':
                    // 继续游戏请求
                    continueRequests.add(msg.id);
                    console.log(`[继续] 玩家 ${msg.id} 请求继续，当前请求数: ${continueRequests.size}`);
                    broadcast(msg); // 广播让对方知道
                    
                    // 当两个玩家都请求继续时，重新发牌
                    if (continueRequests.size >= 2) {
                        continueRequests.clear();
                        dealRequests.clear();
                        
                        const result = dealCards();
                        if (result) {
                            gameState.hands = result.hands;
                            gameState.currentTurn = result.firstTurn;
                            gameState.lastPlay = null;
                            gameState.lastPlayPlayer = null;
                            
                            broadcast({
                                type: 'deal_result',
                                hands: result.hands,
                                firstTurn: result.firstTurn
                            });
                            
                            broadcast({
                                type: 'turn_change',
                                isMyTurn: true,
                                id: result.firstTurn
                            });
                        }
                    }
                    break;
                
                case 'ping':
                    // 心跳
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                
                default:
                    // 其他消息直接广播
                    broadcast(msg);
            }
        } catch (e) {
            console.error(`[错误] 消息解析失败: ${e.message}`);
        }
    });
    
    ws.on('close', () => {
        console.log(`[断开] 玩家 ${ws.playerId} 断开连接`);
        if (ws.playerId) {
            broadcast({ type: 'leave', id: ws.playerId });
        }
        clients.delete(ws);
        
        // 清空该玩家的发牌请求
        dealRequests.delete(ws.playerId);
        // 清空该玩家的继续请求
        continueRequests.delete(ws.playerId);
    });
    
    ws.on('error', (error) => {
        console.error(`[错误] WebSocket错误: ${error.message}`);
    });
});

/**
 * 定时清理（防止内存泄漏）
 */
setInterval(() => {
    console.log(`[状态] 当前连接数: ${clients.size}`);
}, 60000);

/**
 * 优雅关闭
 */
process.on('SIGINT', () => {
    console.log('[关闭] 服务器正在关闭...');
    wss.close(() => {
        console.log('[关闭] 服务器已关闭');
        process.exit(0);
    });
});
