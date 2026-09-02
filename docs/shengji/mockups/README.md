# 升级设计画板（像素参考）

这些 `.dc.html` 是设计画布里的画板原文（也发布在 Claude 设计画布上）。每个文件是一张自包含的 HTML，
所有颜色 / 字号 / 圆角 / 阴影都是内联样式，实现时直接从这里抄数值，不要凭感觉估。

| 文件 | 画板 |
| --- | --- |
| Main.dc.html | 首页 · 桌面 1440×900（三张桌卡 + 入座） |
| HomeMobile.dc.html | 首页 · 手机 390 |
| SjTable.dc.html | 升级牌桌 · 桌面 · 出牌中（记分板 / 牌桌 / 记录三栏，底部手牌扇） |
| SjTableMobile.dc.html | 升级牌桌 · 手机 390×844 |
| SjDeclare.dc.html | 亮主 / 反主 时刻（桌面光池随主花色变色） |
| SjKouDi.dc.html | 扣底（8 槽 + 全手牌展开） |
| SjDig.dc.html | 抠底高潮（底牌翻开、倍数戳记） |
| SjSettle.dc.html | 结算 / 升级面板 |

token 全部来自 `client/styles.css`；升级专属的是深蓝墨绒布 `#14294a / #0c1a33` 与主花色光池色
（♠ #9fb3c8、♥ #e06a74、♣ #7fd2a4、♦ #f0b168、无主 #c9a8ff）。
