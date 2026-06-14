# 双人斗地主

谁规定的斗地主只能三个人玩~~~

## 游戏简介

这是一个基于 WebSocket 的双人斗地主在线对战游戏。两名玩家可以在线匹配对战，支持完整的斗地主玩法。

## 技术栈

- **前端**: 原生 HTML/CSS/JavaScript
- **后端**: Node.js + WebSocket (ws 库)
- **通信**: WebSocket 实时双向通信

## 本地运行

### 1. 安装依赖

```bash
npm install
# 或
bun install
```

### 2. 启动服务器

```bash
node server.js
# 或
bun server.js
```

服务器将在 **8080** 端口启动。

### 3. 打开游戏

直接用浏览器打开 `index.html` 文件，或者使用任意静态服务器托管该文件。

**注意**: 本地运行时，需要修改 `index.html` 中的 WebSocket 地址：

```javascript
// 将此行
serverURL: 'ws://localhost:8080',

// 改为你的服务器地址
serverURL: 'ws://你的IP地址:8080',
```

## 游戏规则

1. 两人对战，每人发 18 张牌（随机移除 15 张）
2. 随机决定先手
3. 支持所有标准斗地主牌型（单张、对子、顺子、炸弹等）
4. 先出完所有牌的一方获胜

## 操作说明

- 点击手牌选中/取消选中
- 选中的牌会上移显示
- 点击「出牌」按钮打出选中的牌
- 点击「不出」跳过本轮

## 文件结构

```
├── index.html    # 游戏前端页面
├── server.js     # WebSocket 后端服务器
├── package.json  # 依赖配置
└── README.md     # 说明文档
```

## 部署说明

### 生产环境部署要点

1. **WebSocket 地址**: 前端需要修改 WebSocket 连接地址为实际服务器地址

2. **端口配置**: 服务器默认使用 8080 端口，可通过修改 `server.js` 中的 `PORT` 变量更改

3. **反向代理**: 如使用 Nginx 等反向代理，需配置 WebSocket 支持

```nginx
# Nginx 配置示例
location /ws {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 许可证

Apache License 2.0
