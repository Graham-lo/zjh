# 升级 P2 浏览器验收截图

按 `docs/shengji/DESIGN.md` 第 5.2 节走的一遍，桌面 1440×900、手机 390×844、
大屏 1920×1080 各一遍。每张都是真实对局里截的（本地 dev server + 无头 Chrome
驱动，四人桌 = 我 + 3 个电脑）。

| 文件 | 对应验收项 |
| --- | --- |
| `desktop-01-home-zjh.png` | 5.2-1 首页选中炸金花：桌卡金边、底色墨绿 |
| `desktop-02-home.png` | 5.2-1 首页选中升级·五十K：底色泛起深蓝墨，入座卡主按钮跟着变 |
| `desktop-03-lobby.png` | 5.2-1 建房、加 3 个电脑、准备 |
| `desktop-04-dealing.png` | 5.2-2 发牌中，亮主按钮已随牌到手出现 |
| `desktop-05-declare.png` | 5.2-2 亮主：花色粒子 + 桌面光池变色 |
| `desktop-06-koudi.png` | 5.2-2 扣底：33 张里选 8 张，8 个槽位逐个填入 |
| `desktop-07-playing.png` | 5.2-2 出牌中：四个出牌区、桌心状态带、手牌扇 |
| `desktop-07-collect.png` | 5.2-2 定圈：四手牌叠飞向赢家 |
| `desktop-08-dig.png` | 5.2-2 抠底：8 张底牌逐张翻 + 倍数戳记 |
| `desktop-09-illegal.png` | 5.2-2 跟牌不合法时按钮变灰 + 下方一行说明原因 |
| `desktop-10-settle.png` | 5.2-2 结算面板（得分条、抠底明细、级别变化、下一局倒计时） |
| `desktop-11-resume.png` | 5.2-3 刷新页面后座位与手牌照常恢复 |
| `desktop-12-tongguan.png` | 5.2-4 打通关房间从 2 开始 |
| `desktop-13-zjh.png` | 5.2-4 炸金花房间照常 |
| `mobile-*.png` | 5.2-3 手机 390×844 的同一套流程 |
| `wide-01-home.png` / `wide-02-playing.png` | 5.2-5 1920×1080：记分板与聊天常驻两侧，手牌卡 92px |

三次验收跑下来控制台都没有报错（只有无头浏览器对 `navigator.vibrate`
缺少用户手势的提示，真实点击环境不会出现）。
