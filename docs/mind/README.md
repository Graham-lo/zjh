# `shared/mind/` — 领域无关的人性底层

这个包描述的是**一个人**，不是一个牌手。它不知道什么是牌、什么是底池、什么是轮次；
它只知道「有件事发生了、我觉得好还是坏、比我预期的差多少、是谁干的」，
以及「我现在有多上头、还有没有力气认真算一遍」。

炸金花是它的第一个使用者，但接口是按「换个领域也能用」设计的：
把股票的一笔平仓、一次谈判、一场竞标折算成同样的几个字段，
同一张人物特征表描述的还是同一个人（设计文档 §4.9 / §4.10）。

## 文件清单

| 文件 | 内容 |
|---|---|
| `emotion.ts` | 情绪状态 `E_t`（七情）、驱力 `D_t`、五维评价 `Appraisal` → 通用映射 → 增量；衰减 `relax()` / 耦合 `couple()`；派生量 `tiltOf` / `easeOf` / `arousalOf` / `fatigueOf` / `referencePoint` / `standingOf`；表达通道 `emotionChannels()` |
| `regularities.ts` | 规律库 R1–R33 的登记表 `REGULARITIES` 与系数读取 `reg()`；跨局结算 `settle(mind, traits, outcome)`；临场规律 `situationalChannels(base, mind, traits, facts)` |
| `dual.ts` | 双系统决策核。唯一入口 `decide(adapter, ctx, mind, traits, rng, fired)`；`p2` 介入概率、意志力预算、`probWeight()`（R26 Prelec）、`framingBias()`（R27）；返回 `{ action, thinkMs, mind, trace }` |
| `traits.ts` | 个人特征表 `Traits` 与常人默认值 `COMMON_TRAITS`（§4.9.6 逐字照抄）、`cloneTraits()` |
| `adapter.ts` | 领域适配器接口 `DomainAdapter<Situation, Action, Event>` 与它的输入输出类型 `CoarseFeatures` / `Impulse` / `Deliberation` / `Scored` |
| `index.ts` | 统一出口 |

## 边界（硬性）

包内任何文件**不得** import `shared/game.ts`、`shared/zjh/**`、`server/**`，
也不得出现「底池 / 单价 / 金花 / 闷牌 / 看牌 / 比牌 / 梭哈 / 轮次 / 牌」这类领域词汇
（§4.10.3）。两条测试在守这条线，都在 `tests/mind.test.ts`：

- `§4.10.4-1 import 图`：扫描 `shared/mind/*.ts` 的全部 import，只允许包内相对路径与 `node:`。
- `§4.10.3 领域词汇`：去掉注释后全文匹配禁用词表。

这两条测试当前**全绿**。它们真的抓到过东西：R25 原来叫「社会性亮牌」，
被这条测试拦下，改成了「社会性展示（主动公开自己的判断）」。

## 一步决策长什么样

```
局面 ──adapter.coarse()──▶ CoarseFeatures（档位与印象，不是小数点后两位）
                                │
                     adapter.intuition() ──▶ 系统 1 冲动 Impulse
                                │              （confidence / feltStrength / feltThreat）
                     p2 = σ(…)  ├──▶ 不介入：出冲动
                                │
                     adapter.deliberate() ──▶ 系统 2 排序 Deliberation
                                │
                  gap > need（need 由 selfControl 决定）才推翻冲动
                                │
                                ▼
                { action, thinkMs, mind, trace }
```

`p2` 的形状（§4.9.7）：爱动脑、赌注大、直觉不笃定 → 更愿意停下来算；
情绪唤醒高、累了、时间紧、局面太熟 → 直接凭直觉。
每介入一次扣一点意志力，一局回一点（R30 自我损耗）。

`trace` 要能回答三个问题：**直觉还是深思**（`system` / `p2` / `engaged` / `overridden`）、
**被哪条规律推了**（`fired`）、**当时什么情绪**（`emotions` / `drives` / `tilt` / `ease` /
`arousal` / `fatigue` / `willpower`）。`deviated` 是「最终动作偏离了系统 2 的最优解」，
§4.9.4 的偏离率数的就是它。

## 量纲约定

- **表达**永远夹在 `[−1, 1]`：`emotionChannels()` 在送进通道之前会 clamp。
- **存量**可以顶到 2（`revenge` 到 3）。这是故意的：「他还没消气」比「他现在有多凶」
  是一个更长的量 —— 顶到 1.4 的怒气脸上和 1.0 一样凶，区别是要多花两三局才消得下去。
  跨局规律往上加时用的就是这个上限，`regularities.ts` 里有同样的说明。
- `Facts` / `CoarseFeatures` 里的比例量都是 `0..1`，站位量 `standing` / `rank` 是 `−1..1`。
- 金额一律是**领域单位**，通用层只用 `magnitudeOf(amount, reference)` 折算成相对量级，
  所以「1 万筹码」和「1 万美元」在这里是同一件事。

## 怎么接一个新领域

实现一个 `DomainAdapter<Situation, Action, Event>`，五个方法：

| 方法 | 你要回答的问题 |
|---|---|
| `appraise(ev, self)` | 这件事**好还是坏**、相对参照点**多大**、比预期**意外**多少、是**谁**干的、我**控制得了**吗（事件自带量纲，不吃局面） |
| `coarse(ctx, self)` | 压成档位：我的东西多好、对面多强、这一步押上多少、这个局面多熟、我现在站在参照点哪一侧 |
| `intuition(f, mind, traits)` | 原型匹配：给每个候选动作一个直觉分，外加 `confidence` / `feltStrength` / `feltThreat` |
| `deliberate(ctx, mind, traits)` | 系统 2 的算账工具（概率模型、前瞻、EV），外加这一步**多难算** |
| `stakes(ctx, self)` | 赌注多大、时间多紧、多熟悉 —— `p2` 公式的三个输入 |

局面**进行中**发生的事，逐条调 `feel(adapter, ev, mind, traits)`：它会走
`appraise` → 通用映射表 `appraisalToDeltas` → 唯一写入口 `nudge`。
情绪必须在一个决策局之内就跟着事件动，只在结算时跳一下的实现是错的。

然后每个「决策局」结束时调一次 `settle(mind, traits, outcome)`，把 `Outcome`
填好（净收益、结算后资产、事前自认的成功概率、归因到谁、有没有被公开检验、
有没有主动退出、本局规模）。跨局的连输连赢、记仇、疲劳、意志力恢复都在这里发生。
结算那一份评价由 `outcomeAppraisal(outcome, mind)` 产出，走的是**同一张表**——
适配器不需要（也不允许）再为「一局结束」写第二套评价代码。

**改情绪只有 `nudge()` 一条路**，钳位只有 `clampEmotion` / `clampDrive` /
`clampRevenge` 三个函数。规律库里的 R7/R8/R18… 也从这条路走。

两个现成的实现可以照抄：

- **炸金花**：`shared/zjh/bot/adapter.ts`（范围模型、前瞻、EV 是它的 `deliberate` 工具）。
- **玩具交易**：`tests/mind.test.ts` 里的 `toyAdapter()` —— 动作只有 `enter/wait/exit`，
  和牌一点关系都没有，用**同一张** `COMMON_TRAITS` 跑出 R1 损失厌恶、R5/R6 连输连赢、
  R7 被具体的人逆势打疼、R30 自我损耗。它就是「这套人能迁移到股市」的可执行证明（§4.10.4-2）。

## 新增一个人

只写一张 `Traits`（在 `COMMON_TRAITS` 上 `cloneTraits()` 再偏斜）加领域侧的习惯，
`shared/mind/` 一行都不用改 —— 这条也有测试（`§4.10.4-3`）。
炸金花这一侧的人物卡在 `shared/zjh/bot/personas/`。

## P3 的领域接线

R17 与 R25 登记为领域侧已接线：前者由公开观察的最近三局窗口实现，后者由展示欲影响表情概率。通用包不保存牌局窗口、不认识人物目录，也不导入自对弈产物。玩具领域测试证明接口可以复用，不证明该模型能预测真实交易行为。
