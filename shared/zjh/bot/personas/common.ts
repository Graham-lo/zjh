/**
 * 「常人」—— P2 唯一的一张人物卡（设计文档 §5：本阶段先用一张常人卡跑通）。
 *
 * 他不是任何一个具体的人，是八个人格的**重心**：会闷牌但不迷恋，算一轮账但不算两轮，
 * 挑软柿子比牌，输大了会有点上头，赢大了会松一点。P3 的八张卡片全部从这一张出发，
 * 往各自的方向拉 —— 岩石把 `lines.偷池` 删掉、`allIn.valueFloor` 拉到顶，
 * 闷牌王把 `look.blindLove` 拉满、加上 `闷压`/`闷比` 的高权重，如此而已。
 */

import { COMMON_TRAITS } from '../../../mind/traits.ts';
import type { Persona } from './types.ts';

export const COMMON_PERSONA: Persona = {
  name: '常人',

  /**
   * 看牌：**没有任何一条固定门槛**。
   *
   * 「看这一眼值多少钱」是 `lookahead.lookValue()` 真算出来的（看完之后我可以把差牌
   * 扔掉、把好牌打大，这个选择权值多少），下面这些权重只是把「人的习惯」叠上去：
   * 有人在开火想看一眼、这一口开始肉疼想看一眼、打了几轮了想看一眼 —— 全是连续的推力。
   * `blindLove` 是反方向的那一股：闷着只掏一半钱，这件事本身就让人舍不得看。
   */
  look: {
    appetite: 0.90,
    blindLove: 0.50,
    pressureWeight: 0.26,
    costWeight: 0.85,
    roundWeight: 1.50,
    tierWeight: 0.70,
    allInWeight: 0.30,
  },

  /** 常人九条线路都会走，只是各有偏好。P3 的卡片靠**删掉**某几条来区分。 */
  lines: {
    便宜看戏: { weight: 0.10, commit: 0.30 },
    闷压: { weight: 0.40, commit: 0.42 },
    闷比: { weight: 0.05, commit: 0.30 },
    养池: { weight: 1.00, commit: 0.52 },
    价值加压: { weight: 1.00, commit: 0.40 },
    偷池: { weight: 0.52, commit: 0.80 },
    跟到底看: { weight: 0.92, commit: 0.30 },
    收口: { weight: 1.00, commit: 0.58 },
    弃: { weight: 1.00, commit: 0.50 },
  },

  cognition: {
    rangeFidelity: 2, lookahead: 1, readsTiming: false, classifyOthers: 'coarse',
    /**
     * 系统 1 的原型表偏斜（§4.9.7）。常人基本按牌面认档，只有两处人味：
     * 豹子/顺金在**感觉上**比实际还大一点（谁拿到都会兴奋），
     * 闷牌时对没看过的牌有一层薄薄的幻想（R16 在通道层还会再加一次）。
     */
    s1Prototypes: { monster: 1.06, strong: 1.0, medium: 0.98, weak: 0.96, blind: 1.05 },
  },

  biases: { sunkCost: 0.30, gamblersFallacy: 0.18, lossAversion: 0.28, overconfidence: 0.10 },

  compare: { heads: 0.55, multi: 0.65, blind: 0.55, grudge: 0.40, softness: 1, milk: 0.55 },

  allIn: {
    initiate: 0.42,
    valueFloor: 0.80,
    bluff: 0.05,
    accept: 0,
    blindAccept: 0.45,
    foldEquityWeight: 0.70,
  },

  /** 温和的一条情绪曲线：输掉一成上头，三局左右退干净；赢大了松一点。 */
  emotion: { tiltTrigger: 0.10, tiltGain: 0.85, decay: 0.72, ease: 0.30, grudge: 0.55 },

  /**
   * 通用特征表照抄设计文档 §4.9.6 的常人默认值（`COMMON_TRAITS`）。
   * 常人的规律系数全是 1 —— 他每一条毛病都有，每一条都不重。
   */
  traits: COMMON_TRAITS,

  tempo: { base: 380, dive: 3200, theatre: 0.30, noise: 0.05, leak: 0, tell: 'none', snapRaise: 0 },

  emotes: { rate: 0.35, favourites: ['🤔', '👍', '😂'], cap: 2 },

  leaks: [
    '线路认得太死：偷池被跟之后一定会在下一个信息点退出，盯着他的人可以只用跟注就把他的诈唬全部收掉',
    '闷牌的价值只按半价算，不会为了掩护而在高档位继续闷 —— 升到 10 万档时他几乎一定已经看过牌',
  ],
};
