# 双人斗地主

谁规定的斗地主只能三个人玩~


## 技术栈

· 前端：原生HTML/CSS/JavaScript
· 后端：Node.js + WebSocket（ws库）
· 通信：WebSocket实时双向通信


## 游戏规则

1. 两人对战，每人发 18 张牌（随机移除 15 张）
2. 随机决定先手
3. 注：未设置任何出牌规则，一切凭双方玩家自觉
4. 先出完所有牌的一方获胜


## 本地运行
（省流：**未适配**云端部署和大于2人的场景，**只能作为家庭游戏，并在同一个WiFi的环境中游玩。**若计划部署上线或希望远程联机，请自行调整代码）

1. 克隆仓库并进入仓库

```bash
git clone https://github.com/conch-6/two-player-landlord && cd two-player-landlord/
```

2. 安装依赖

```bash
npm install
```

3. 启动服务器

```bash
node server.js
```

4. 服务器将在 **6660** 端口启动。
```bash
http://<你的IP>:6660   # 局域网范围内使用
或
http://localhost:6660   # 只能在运行服务器的设备上使用
```


## 文件结构

```
├── index.html    # 游戏前端页面
├── server.js     # 后端服务器
├── package.json  # 依赖配置
└── README.md     # 本文档
```


## 许可证

Apache License 2.0
