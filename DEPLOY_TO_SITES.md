# 在 ChatGPT Sites 中发布

把整个项目交给 ChatGPT Work / Sites，然后使用下面这条指令：

> Deploy this project with Sites. Create a new Sites project and provision a new D1 database using the DB binding declared in `.openai/hosting.json`. Run `npm test` and `npm run build` before deployment. If either fails, fix only build/runtime compatibility issues without changing the game rules or exposing hidden cards. Save a version, deploy it, and make the Site public so anyone with the URL can open it. Keep the game private-room based (6-digit room code), server-authoritative, and virtual-points-only. Do not add payments, purchases, deposits, withdrawals, transfers, prizes, cash value, wagering with money, or any redeemable value.

发布完成后：

1. 打开 Site URL。
2. 系统自动分配昵称，直接创建房间。
3. 点“复制邀请”，把链接发给好友。
4. 好友点邀请页的“加入房间”；房主可用电脑玩家补位。
5. 所有积分只用于这款游戏中的娱乐计分，不可充值、提现、转让或兑换。

## 发布前应看到的检查结果

- `npm test`：10/10 核心游戏测试通过（本交付包已验证）。
- `npm run build`：需要 Sites/联网环境安装依赖后执行。
- `.openai/hosting.json`：D1 binding 为 `DB`。
- 不应向非本人客户端返回未公开暗牌。
