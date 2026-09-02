/**
 * 升级牌桌的纯计算：花色符号、座位方位、亮主候选、出牌按钮文案。
 *
 * 规则判定一律复用 `shared/sj/*` 里那一份 —— 客户端只用自己的手牌就能完整判断
 * 跟牌合法性（甩牌除外，那要别人的手牌，由服务端裁决），所以这里不重写任何规则。
 */
import {
  SUIT_NAME, SUIT_SYMBOL, cardFromId, cardsLabel, groupOf, levelLabel, sumPoints,
  type SjCard, type SjCtx, type SjPlainSuit, type SjTrumpSuit,
} from '../../shared/sj/cards.ts';
import type { SjPublicPlayer, SjPublicRoom, SjTrumpState } from '../../shared/sj/engine.ts';
import { allPairs, allTractors, cardsInGroup, parseShape, type SjShape } from '../../shared/sj/units.ts';
import {
  followRequirement, legalDeclarations, shapeLabel, unitLabel, validateFollow, validateLead,
  type SjDeclKind,
} from '../../shared/sj/rules.ts';
import type { SjVoiceKey } from '../voice-lines.ts';

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

export const TRUMP_VOICE: Record<SjTrumpSuit, SjVoiceKey> = {
  S: 'sj_trump_s', H: 'sj_trump_h', C: 'sj_trump_c', D: 'sj_trump_d', NT: 'sj_nt',
};

/* ------------------------------------------------------- 语音（DESIGN 3.6） */

/**
 * 亮主 / 加固 / 反主 / 抄底 念什么。
 *
 * 花色和事件各自是一句短台词，靠 `voice.play(a, b)` 连读成「反主！红桃主」，
 * 而不是为每个组合单录一句 —— 4 个花色 × 4 种事件会变成 16 句。
 */
export function declareVoice(
  ev: { trump: SjTrumpSuit; strength: number; reinforce?: boolean },
  opts: { chao?: boolean; override?: boolean } = {},
): SjVoiceKey[] {
  const suit = TRUMP_VOICE[ev.trump];
  if (opts.chao) return ['sj_chao', suit];
  if (ev.reinforce) return ['sj_reinforce'];
  if (opts.override) return ['sj_fanzhu', suit];
  if (ev.trump === 'NT') return ['sj_nt'];
  // 亮对子时先报「一对」，念出来是「一对，黑桃主」
  return ev.strength >= 2 ? ['sj_trump_pair', suit] : [suit];
}

/**
 * 一手牌念什么（DESIGN 3.6）。
 *
 * 一局 25 圈、100 手牌，每手都报牌型会吵到被关掉，所以只有**有信息量**的时刻
 * 出声：首出报牌型与吊主，跟牌只在毙 / 盖毙 / 垫出分牌时出声，跟不上又没分的
 * 垫牌一律安静。最后一圈开打前额外报一句。
 */
export function playVoice(
  room: SjPublicRoom,
  ev: { playerId: string; cardIds: string[]; unit: 'single' | 'pair' | 'tractor' | 'throw'; trumped: boolean },
): SjVoiceKey[] {
  const seat = room.players.find((p) => p.id === ev.playerId)?.seat;
  if (seat == null) return [];
  const ctx = ctxOf(room);
  const cards = ev.cardIds.map(cardFromId);
  if (!cards.length) return [];
  // 收圈那一下 room.trick 已经清空了，第四手要回头看 lastTrick 才知道自己排第几
  const trick = room.trick.length ? room.trick : (room.lastTrick?.plays ?? []);
  const idx = trick.findIndex((t) => t.seat === seat);
  if (idx < 0 || !trick.length) return [];
  const leadGroup = groupOf(cardFromId(trick[0].cardIds[0]), ctx);

  if (ev.trumped) {
    // 盖毙：这一圈在我之前已经有人用主牌毙过了
    const covered = trick.slice(1, idx).some((t) => groupOf(cardFromId(t.cardIds[0]), ctx) === 'T');
    return [covered ? 'sj_gaibi' : 'sj_bi'];
  }

  if (idx === 0) {
    // 首出者手里清空 = 这是最后一圈：牌局里只有最后一圈才会在首出后就没牌了
    const last = room.players.find((p) => p.seat === seat)?.handCount === 0 ? ['sj_last' as const] : [];
    if (groupOf(cards[0], ctx) === 'T') return [...last, 'sj_diao'];
    if (ev.unit === 'throw') return [...last, 'sj_shuai'];
    if (ev.unit === 'tractor') return [...last, 'sj_tractor'];
    if (ev.unit === 'pair') return [...last, 'sj_pair'];
    return last;
  }

  // 跟牌：垫出去的牌里带分才值得出声 —— 那是把分送给了赢这一圈的人
  const discard = cards.every((c) => {
    const g = groupOf(c, ctx);
    return g !== leadGroup && g !== 'T';
  });
  return discard && sumPoints(cards) > 0 ? ['sj_dian'] : [];
}

/** 结算念什么 */
export function handEndVoice(o: { defendersWin: boolean; up: number; label: string }): SjVoiceKey[] {
  if (o.label === '大光') return ['sj_daguang'];
  if (o.label === '小光') return ['sj_xiaoguang'];
  if (o.defendersWin) return o.up > 0 ? ['sj_shangtai', 'sj_levelup'] : ['sj_shangtai'];
  return ['sj_shouzhu', 'sj_levelup'];
}

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

const DECL_GLYPH: Record<SjDeclKind, (level: number, suit: SjTrumpSuit) => string> = {
  single: (level, suit) => `${SUIT_SYMBOL[suit as SjPlainSuit]}${levelLabel(level)}`,
  pair: (level, suit) => `${SUIT_SYMBOL[suit as SjPlainSuit]}${levelLabel(level)}`,
  joker_s: () => '小王',
  joker_b: () => '大王',
};

/**
 * 我手里**现在真的亮得成**的亮法，按档位从弱到强排（DESIGN 3.4 / 1.4b）。
 *
 * 枚举与合法性全部来自 `shared/sj/rules.ts` 的 `legalDeclarations` ——
 * 服务端的 `doDeclare` / `doChao` 走的是同一条判据，所以**按钮点得亮的，服务端一定收**。
 * `mode` 区分亮主窗口（允许同花色加固）和抄底询问（不能自反，只有对王能反自己）。
 */
export function declareOptions(
  hand: SjCard[], trump: SjTrumpState, myId: string, mode: 'declare' | 'chao' = 'declare',
): DeclareOption[] {
  const level = trump.level;
  const isDeclarer = trump.declarerId === myId;
  return legalDeclarations(hand, level, trump, myId, mode).map((o) => {
    // 加固：我已经用这门花色亮了单张，再补一张同花色级牌把它抬成这门花色的一对
    const reinforce = mode === 'declare' && isDeclarer && trump.strength === 1
      && o.kind === 'pair' && trump.suit === o.trump;
    const note = o.kind === 'single' ? '单张'
      : o.trump === 'NT' ? '一对 · 无主'
        : reinforce ? '一对 · 加固' : '一对';
    return {
      key: `${o.kind}-${o.trump}`,
      cardIds: o.cards.map((c) => c.id),
      strength: o.strength,
      glyph: DECL_GLYPH[o.kind](level, o.trump),
      note: mode === 'chao' ? `${note} · 抄底` : note,
      trump: o.trump,
      reinforce,
    };
  });
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
