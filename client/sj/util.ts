/**
 * 升级牌桌的纯计算：花色符号、座位方位、亮主候选、出牌按钮文案。
 *
 * 规则判定一律复用 `shared/sj/*` 里那一份 —— 客户端只用自己的手牌就能完整判断
 * 跟牌合法性（甩牌除外，那要别人的手牌，由服务端裁决），所以这里不重写任何规则。
 */
import {
  SUIT_NAME, SUIT_SYMBOL, cardFromId, cardsLabel, groupOf, levelLabel,
  type SjCard, type SjCtx, type SjPlainSuit, type SjTrumpSuit,
} from '../../shared/sj/cards.ts';
import type { SjPublicPlayer, SjPublicRoom, SjTrumpState } from '../../shared/sj/engine.ts';
import { allPairs, allTractors, cardsInGroup, parseShape, type SjShape } from '../../shared/sj/units.ts';
import { followRequirement, shapeLabel, unitLabel, validateFollow, validateLead } from '../../shared/sj/rules.ts';
import type { VoiceKey } from '../sound.ts';

/** 桌面顶灯的光池色随主花色变 —— 整桌最强的记忆点（DESIGN 3.2） */
export const TRUMP_TINT: Record<SjTrumpSuit, string> = {
  S: '#9fb3c8',
  H: '#e06a74',
  C: '#7fd2a4',
  D: '#f0b168',
  NT: '#c9a8ff',
};

export const trumpGlyph = (t: SjTrumpSuit | null) => (t === 'NT' ? '無' : t ? SUIT_SYMBOL[t] : '—');

export function trumpText(t: SjTrumpSuit | null, level: number): string {
  if (!t) return `未定主 · 打 ${levelLabel(level)}`;
  return t === 'NT' ? `无主 · 打 ${levelLabel(level)}` : `${SUIT_SYMBOL[t]} 主 · 打 ${levelLabel(level)}`;
}

export const TRUMP_VOICE: Record<SjTrumpSuit, VoiceKey> = {
  S: 'trump_s', H: 'trump_h', C: 'trump_c', D: 'trump_d', NT: 'nt',
};

export const ctxOf = (room: { trump: { suit: SjTrumpSuit | null; level: number } }): SjCtx => ({
  trump: room.trump.suit,
  level: room.trump.level,
});

/* --------------------------------------------------------------- 座位方位 */

export type SjSpot = 'me' | 'left' | 'top' | 'right';

/**
 * 座位 0–3 顺时针。从我这一侧俯看，顺时针的下一位在**屏幕左边**，
 * 再下一位在对面（一定是我的对家，因为 team = seat % 2），最后一位在右边。
 */
export const SPOTS: SjSpot[] = ['me', 'left', 'top', 'right'];

export function spotOf(seat: number, mySeat: number): SjSpot {
  return SPOTS[(seat - mySeat + 4) % 4];
}

export function seatBySpot(room: SjPublicRoom, mySeat: number): Record<SjSpot, SjPublicPlayer | undefined> {
  const out = {} as Record<SjSpot, SjPublicPlayer | undefined>;
  for (const spot of SPOTS) out[spot] = undefined;
  for (const p of room.players) out[spotOf(p.seat, mySeat)] = p;
  return out;
}

export const teamOfSeat = (seat: number): 0 | 1 => ((seat % 2) as 0 | 1);

/* --------------------------------------------------------------- 亮主候选 */

export interface DeclareOption {
  key: string;
  cardIds: string[];
  strength: number;
  /** 按钮上那个大号的花色/点数标记 */
  glyph: string;
  /** 跟在标记后面的一行小字 */
  note: string;
  trump: SjTrumpSuit;
  reinforce: boolean;
}

/**
 * 我手里**做得到**的亮法，按强度排序（DESIGN 3.4）。
 *
 * 规则和 `readDeclaration` / `doDeclare` 逐条对齐：必须严格更强才能反主；
 * 当前亮主者只能用同花色第二张级牌加固，或者用对王把自己反成无主。
 */
export function declareOptions(hand: SjCard[], trump: SjTrumpState, myId: string): DeclareOption[] {
  const level = trump.level;
  const isDeclarer = trump.declarerId === myId;
  const out: DeclareOption[] = [];

  for (const suit of ['S', 'H', 'C', 'D'] as SjPlainSuit[]) {
    const levels = hand.filter((c) => c.suit === suit && c.rank === level);
    if (!levels.length) continue;
    const face = `${SUIT_SYMBOL[suit]}${levelLabel(level)}`;
    // 加固：我已经用这门花色亮了单张，再补一张同花色级牌把强度抬到 2
    const reinforce = isDeclarer && trump.strength === 1 && trump.suit === suit;
    if (!isDeclarer && levels.length >= 1) {
      out.push({
        key: `${suit}1`, cardIds: [levels[0].id], strength: 1, glyph: face,
        note: '单张', trump: suit, reinforce: false,
      });
    }
    if (levels.length >= 2 && (!isDeclarer || reinforce)) {
      out.push({
        key: `${suit}2`, cardIds: [levels[0].id, levels[1].id], strength: 2, glyph: face,
        note: reinforce ? '一对 · 加固' : '一对', trump: suit, reinforce,
      });
    }
  }

  const small = hand.filter((c) => c.suit === 'J' && c.rank === 15);
  const big = hand.filter((c) => c.suit === 'J' && c.rank === 16);
  if (small.length >= 2) {
    out.push({
      key: 'nt3', cardIds: [small[0].id, small[1].id], strength: 3, glyph: '小王',
      note: '一对 · 无主', trump: 'NT', reinforce: false,
    });
  }
  if (big.length >= 2) {
    out.push({
      key: 'nt4', cardIds: [big[0].id, big[1].id], strength: 4, glyph: '大王',
      note: '一对 · 无主', trump: 'NT', reinforce: false,
    });
  }

  return out.filter((o) => o.strength > trump.strength).sort((a, b) => a.strength - b.strength);
}

/* ------------------------------------------------------------ 出牌按钮文案 */

export interface PlayCheck {
  ok: boolean;
  /** 按钮上的文案：出牌 · 对子 / 出牌 · 拖拉机 ×2 / 甩牌 5 张 */
  label: string;
  /** 不合法时按钮下方那一行说明 */
  reason: string;
  shape: SjShape | null;
}

function labelOf(shape: SjShape): string {
  if (shape.isThrow) return `甩牌 ${shape.count} 张`;
  const u = shape.units[0];
  if (u.kind === 'tractor') return `出牌 · 拖拉机 ×${u.span}`;
  return `出牌 · ${unitLabel(u)}`;
}

/** 当前选中的牌能不能出，以及按钮该写什么（DESIGN 3.4） */
export function checkPlay(hand: SjCard[], selected: SjCard[], lead: SjShape | null, ctx: SjCtx): PlayCheck {
  if (!selected.length) return { ok: false, label: '出牌', reason: lead ? `跟 ${lead.count} 张` : '先选牌', shape: null };
  const shape = parseShape(selected, ctx);
  if (!lead) {
    const check = validateLead(selected, ctx);
    if (!check.ok) return { ok: false, label: '出牌', reason: check.reason, shape: null };
    return { ok: true, label: labelOf(shape!), reason: '', shape };
  }
  const check = validateFollow(hand, lead, selected, ctx);
  if (!check.ok) return { ok: false, label: `出牌 · ${selected.length} 张`, reason: check.reason, shape };
  return { ok: true, label: shape ? labelOf(shape) : `跟牌 · ${selected.length} 张`, reason: '', shape };
}

/* ------------------------------------------------------------ 智能点选 */

/**
 * 单击一张牌时应该预选的完整单位/出法。
 *
 * 首出按“最长连对 > 对子 > 单张”扩展；跟牌先采用收益排序里包含该牌的合法整手，
 * 再按必须跟的拖拉机/对子结构补一个本地兜底。这里只改变选中态，绝不替玩家提交出牌。
 */
export function smartPickForCard(
  hand: SjCard[], clicked: SjCard, lead: SjShape | null, ctx: SjCtx,
  ranked: readonly SjCard[][] = [],
): string[] {
  if (lead) {
    const rankedHit = ranked.find((cards) => cards.some((c) => c.id === clicked.id));
    if (rankedHit) return rankedHit.map((c) => c.id);

    const groupCards = cardsInGroup(hand, lead.group, ctx);
    if (groupCards.length >= lead.count && groupCards.some((c) => c.id === clicked.id)) {
      const req = followRequirement(groupCards, lead, ctx);
      for (const span of req.tractors.slice().sort((a, b) => b - a)) {
        const tractor = allTractors(hand, lead.group, ctx)
          .filter((u) => u.span === span && u.cards.some((c) => c.id === clicked.id))
          .sort((a, b) => b.span - a.span || a.top - b.top)[0];
        if (tractor) return tractor.cards.map((c) => c.id);
      }
      if (req.pairs > 0) {
        const pair = allPairs(hand, lead.group, ctx).find((u) => u.cards.some((c) => c.id === clicked.id));
        if (pair) return pair.cards.map((c) => c.id);
      }
    }
    return [clicked.id];
  }

  const group = groupOf(clicked, ctx);
  const tractor = allTractors(hand, group, ctx)
    .filter((u) => u.cards.some((c) => c.id === clicked.id))
    .sort((a, b) => b.span - a.span || a.top - b.top)[0];
  if (tractor) return tractor.cards.map((c) => c.id);
  const pair = allPairs(hand, group, ctx).find((u) => u.cards.some((c) => c.id === clicked.id));
  return pair ? pair.cards.map((c) => c.id) : [clicked.id];
}

/* ------------------------------------------------------------ 甩牌失败文案 */

/**
 * 甩牌被判失败时给玩家看的那句话。
 *
 * 服务端**已经替他打出了最小的那个单位**（`shared/sj/engine.ts` 的 `doPlay`），
 * 只有其余的牌退回手里。但界面上看到的是一把牌抖着飞回手牌扇，很容易误以为
 * 「什么都没出成」—— 所以这句话必须先说打出了什么，再说退回了几张。
 */
export function throwFailText(forcedIds: string[], backCount: number): string {
  const forced = cardsLabel(forcedIds.map(cardFromId));
  const back = backCount > 0 ? `，其余 ${backCount} 张退回手里` : '';
  return `甩牌失败，已强制打出 ${forced}${back}，罚 10 分`;
}

/** 本圈的首出结构，客户端算一遍就够（服务端有自己的一份） */
export function leadShape(room: SjPublicRoom): SjShape | null {
  if (!room.trick.length) return null;
  return parseShape(room.trick[0].cardIds.map(cardFromId), ctxOf(room));
}

/** 本圈已经在桌上的分 */
export function trickPointsOf(room: SjPublicRoom): number {
  let n = 0;
  for (const play of room.trick) {
    for (const id of play.cardIds) {
      const c = cardFromId(id);
      if (c.suit === 'J') continue;
      if (c.rank === 5) n += 5;
      else if (c.rank === 10 || c.rank === 13) n += 10;
    }
  }
  return n;
}

/** 首出牌型的中文说明，桌心那条状态带用 */
export const leadText = (lead: SjShape | null) => (lead ? shapeLabel(lead) : '');

export const suitName = (s: SjTrumpSuit) => (s === 'NT' ? '无主' : SUIT_NAME[s]);
