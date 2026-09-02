/**
 * 多游戏房间框架的常量与类型（DESIGN 2.1 / 1.11）。
 *
 * 这一版只放"有哪些游戏、各自长什么样"；按 kind 派发到引擎的注册表留到 P2，
 * 那时候 Hub 才需要它。放在这里是为了让首页、协议、内核从一开始就引用同一份定义。
 */

export type SjKind = 'sj_510k' | 'sj_2a';
export type GameKind = 'zjh' | SjKind;

/**
 * 升级的两个变体：区别只有级牌阶梯一个数组。
 * 「打通关」用户原话是"从 1 打到 K"，按标准 2→A 阶梯理解（DESIGN 产品决定 2）。
 */
export const SJ_VARIANTS = {
  sj_510k: { label: '五十K', ladder: [5, 10, 13], tagline: '打 5、打 10、打 K，三级定胜负' },
  sj_2a: { label: '打通关', ladder: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], tagline: '从 2 一路打到 A' },
} as const;

export const SJ_KINDS: SjKind[] = ['sj_510k', 'sj_2a'];

export function isSjKind(kind: string): kind is SjKind {
  return kind === 'sj_510k' || kind === 'sj_2a';
}

export interface GameMeta {
  label: string;
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  /** 用几副牌。首页桌卡上的小标 */
  decks: number;
}

export const GAME_META: Record<GameKind, GameMeta> = {
  zjh: { label: '炸金花', tagline: '豹子 顺金 金花，闷牌半价看牌双倍', minPlayers: 2, maxPlayers: 6, decks: 1 },
  sj_510k: { label: '升级 · 五十K', tagline: SJ_VARIANTS.sj_510k.tagline, minPlayers: 4, maxPlayers: 4, decks: 2 },
  sj_2a: { label: '升级 · 打通关', tagline: SJ_VARIANTS.sj_2a.tagline, minPlayers: 4, maxPlayers: 4, decks: 2 },
};

/** 变体的级牌阶梯。两队新建房间时都从阶梯第一级起（DESIGN 1.3） */
export function ladderOf(kind: SjKind): number[] {
  return [...SJ_VARIANTS[kind].ladder];
}
