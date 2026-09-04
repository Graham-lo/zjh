/**
 * 人格目录（设计文档 §4.7）。
 *
 * 八张手写卡 + 一张常人卡，`personaFor` 按名字查表。决策路径**完全走人物卡**：
 * `decide.ts` 里没有「一个理性引擎 + 7 维性格滤镜」那套结构。
 *
 * P2 期间这里还有一段过渡映射（`BotPersonality` 7 维表 + `botPersonality` +
 * `tuneTraits` + `tuneLine`），作用是在手写卡到位之前把常人卡往六个方向各推一把，
 * 免得一桌是六个一模一样的人。八张卡合并进名册之后（集成第 2 步）整段删除 ——
 * 它从来不参与决策，删掉不改变任何决策逻辑，只是不再有「半个人」这种东西。
 */

import type { PlayerState } from '../../../game.ts';
import { COMMON_PERSONA } from './common.ts';
import { 阿杰 } from './阿杰.ts';
import { 阿凯 } from './阿凯.ts';
import { 老陈 } from './老陈.ts';
import { 小北 } from './小北.ts';
import { LAOWANG } from './laowang.ts';
import { XIAOLIN } from './xiaolin.ts';
import { XIAOYU } from './xiaoyu.ts';
import { ABIAO } from './abiao.ts';
import type { Persona } from './types.ts';

export { COMMON_PERSONA } from './common.ts';
export { 阿杰 } from './阿杰.ts';
export { 阿凯 } from './阿凯.ts';
export { 老陈 } from './老陈.ts';
export { 小北 } from './小北.ts';
export { LAOWANG } from './laowang.ts';
export { XIAOLIN } from './xiaolin.ts';
export { XIAOYU } from './xiaoyu.ts';
export { ABIAO } from './abiao.ts';
export * from './types.ts';

/* ----------------------------------------------------------- 人格目录 */

/**
 * 手写人物卡的名册（设计文档 §4.7.3）。名字 → 卡片，一一对应。
 *
 * 名字就是身份：`personaFor` 查这张表，查到了就是 §4.7.3 里那个人；
 * 查不到（`电脑3`、测试台上临时起的名字）就是常人卡，没有中间态。
 * 同名机器人跨房间跨天必须是同一个人（§4.7.1），所以这里是**静态表**，不带随机。
 *
 * 八张卡两条线合并而来：A 线（阿杰/阿凯/老陈/小北）、B 线（老王/小林/小雨/阿彪）。
 * `shared/game.ts` 的 `BOT_NAMES` 与这张表一一对应：八个名字全部走手写卡。
 */
export const PERSONAS: Record<string, Persona> = {
  阿杰,            // 老油条（紧凶）
  阿凯,            // 赌徒（松凶 / 上头王）
  老陈,            // 岩石（老实人）
  小北,            // 跟注站（看戏的）
  老王: LAOWANG,   // 闷牌王（演员）
  小林: XIAOLIN,   // 数学型（算账的）
  小雨: XIAOYU,    // 新手（乱打的）
  阿彪: ABIAO,     // 复仇者（记仇的）
};

/**
 * 这个座位上坐的是谁。
 *
 * 名字就是身份：名册（`PERSONAS`）里查得到就是 §4.7.3 里那个人，查不到就是常人卡。
 * P2 期间这里还有一段「常人卡 + 7 维形变」的过渡映射，八张手写卡进名册之后
 * （集成第 2 步）连同 `BOT_PERSONALITIES` / `botPersonality` / `tuneTraits` 一起删掉了：
 * 现在不存在「半个人」，要么是名册上的那个人，要么是常人。
 *
 * 同名机器人跨房间跨天必须是同一个人（§4.7.1）—— 两条分支返回的都是同一个静态对象，
 * 天然稳定，不需要缓存。
 */
export function personaFor(bot: Pick<PlayerState, 'id' | 'name'>): Persona {
  return PERSONAS[bot.name] ?? COMMON_PERSONA;
}

/**
 * 「这个人上头得多重」，以常人为 1 的归一化倍数。
 *
 * 唯一的来源是人物卡自己写的 `emotion.tiltGain`（§4.9.6：跟注站 0.10、岩石/数学型
 * 0.15、老油条 0.35、闷牌王 0.70、常人/新手 0.85、复仇者 1.05、赌徒 1.50）。
 * `ch.tilt` 本身是**读数**（`tiltOf(m) = 0.7×怒 + 0.5×思`），不带人物色彩：
 * 同样被打疼一次，岩石和赌徒读出来的 tilt 差不了几倍，可「上头之后会怎样」
 * 是天差地别的两个人。所以凡是「按上头程度改一个人的打法」的地方，
 * 系数都要过这一道，而不是让 `ch.tilt` 自己拿一个写死的斜率。
 *
 * 归一化到常人 = 1 而不是直接用 `tiltGain`，是为了让常人卡的行为一个数都不变 ——
 * 这一层是**给人物之间拉开差距**用的，不是给所有人整体挪一格用的。
 */
export function tiltFactor(persona: Persona): number {
  return persona.emotion.tiltGain / COMMON_PERSONA.emotion.tiltGain;
}
