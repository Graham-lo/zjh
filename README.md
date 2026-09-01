# 好友炸金花 · ChatGPT Sites

一个面向好友私下娱乐的 2–6 人房间制炸金花。项目按 OpenAI 官方 ChatGPT Sites Vinext starter 的当前运行方式组织，使用 D1 保存权威房间状态。

## 已实现

- 系统自动分配昵称；6 位房间号 + 一键加入邀请链接
- 2–6 名真人好友，房主可添加电脑玩家补位
- 服务端权威洗牌与发牌
- 玩家未“看牌”前，API 连自己的底牌都不会返回，避免浏览器开发者工具偷看
- 跟注、加注、弃牌、比牌、封顶梭哈
- 豹子 > 同花顺 > 同花 > 顺子 > 对子 > 单张
- A23 作为最小顺子；默认开启不同花 235 克豹子规则
- 看牌后下注成本翻倍
- 只剩两名活跃玩家时立即开放比牌；其他情况按房规在首轮后开放
- 比牌消耗为当前跟注额的 2 倍；积分不足跟注时可梭哈并强制所有在局玩家依次开牌
- D1 + 乐观并发控制，避免两名玩家同时操作覆盖状态
- 房主退出时自动把房主身份移交给仍在线的真人；掉线玩家可由房主代弃
- 进行中也可加入房间并等待下一局
- 前台约 550ms、后台约 1.8s 的非重叠状态同步；成员加入会即时更新人数并提示
- 本地 token 断线重进同一浏览器可恢复身份
- 桌面与手机响应式牌桌
- 虚拟积分：默认 10,000，底注 100；不充值、不转让、不提现、不兑换

## 为什么默认没有用 WebSocket 广播

ChatGPT Sites 当前明确支持 WebSocket，但官方公开文档没有给出一个适合多人房间的“跨实例共享 WebSocket 房间协调器”约束。为了不把正确性建立在单进程内存上，本版本把 D1 当作唯一权威状态并用短轮询同步。6 人回合制牌局的负载很低，且多实例部署时更稳。

后续若 Sites 提供明确的持久房间协调 primitive，可以在不改游戏状态机的前提下把同步层替换成 WebSocket 推送。

## 本地

需要 Node.js >= 22.13。

```bash
npm install
npm test
npm run dev
```

## 部署到 ChatGPT Sites

`.openai/hosting.json` 已声明 D1 binding 为 `DB`，并绑定到本项目对应的 Site。

在 ChatGPT Work / Sites 中打开此项目后要求：

> Deploy this project with Sites. Reuse the project_id and provisioned D1 database declared through .openai/hosting.json. Run the tests and build first. Save a version, deploy it, and keep the Site public so anyone with the URL can join a private room. Do not add payments, purchases, cash value, transfers, withdrawals, prizes, or any real-money functionality.

首次发布后把 Site URL 发给好友即可。房间仍由 6 位房间号隔离。

## 说明

这是纯娱乐积分游戏。代码没有充值、提现、积分转移、奖品、现金或虚拟资产兑换能力，也不应添加这些能力。
