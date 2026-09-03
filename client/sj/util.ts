/**
 * 升级牌桌的纯计算：花色符号、座位方位、亮主候选、出牌按钮文案。
 *
 * 规则判定一律复用 `shared/sj/*` 里那一份 —— 客户端只用自己的手牌就能完整判断
 * 跟牌合法性（甩牌除外，那要别人的手牌，由服务端裁决），所以这里不重写任何规则。
 */
import {
  SUIT_NAME, SUIT_SYMBOL, cardFromId, cardOrder, cardsLabel, groupOf, levelLabel, sumPoints,
  type SjCard, type SjCtx, type SjPlainSuit, type SjTrumpSuit,
} from '../../shared/sj/cards.ts';
import { forcedCompletion, legalFollowsContaining } from '../../shared/sj/complete.ts';
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
  /**
   * 合法、但**出之前该知道一句**的提醒：甩牌可能被管上罚分、这一手是"毙"。
   * 和 `reason` 分开：那个是"不让出"，这个是"能出，但你知道自己在干什么吗"。
   */
  note: string;
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
  if (!selected.length) {
    return { ok: false, label: '出牌', reason: lead ? `跟 ${lead.count} 张` : '先选牌', note: '', shape: null };
  }
  const shape = parseShape(selected, ctx);
  if (!lead) {
    const check = validateLead(selected, ctx);
    if (!check.ok) return { ok: false, label: '出牌', reason: check.reason, note: '', shape: null };
    // 甩牌成不成要看别人的手牌，客户端拦不住也不该拦 —— 但按之前得先把风险说清楚
    const note = shape!.isThrow ? '甩牌：只要有一家管得上其中一个单位，就要罚 10 分' : '';
    return { ok: true, label: labelOf(shape!), reason: '', note, shape };
  }
  const check = validateFollow(hand, lead, selected, ctx);
  if (!check.ok) return { ok: false, label: `出牌 · ${selected.length} 张`, reason: check.reason, note: '', shape };
  // 缺门时整手主牌就是"毙"：这一圈的分要么被自己吃下，要么被后面的人盖毙抢走
  const bi = lead.group !== 'T' && selected.every((c) => groupOf(c, ctx) === 'T');
  return {
    ok: true,
    label: shape ? labelOf(shape) : `跟牌 · ${selected.length} 张`,
    reason: '',
    note: bi ? '毙：用主牌吃这一圈，后面的人还能盖毙' : '',
    shape,
  };
}

/* ---------------------------------------------------------- 选牌（纯函数） */

/**
 * 单击一张牌之后的新选中集：**只动这一张**。
 *
 * 取消永远是纯粹的取消（系统补上的牌也一张张放得下）；选中之后才问一句「规则允许它
 * 单独出现吗」—— `forcedCompletion` 给的是所有合法出法的交集，也就是躲不开的那些牌。
 * `complete=false`（不在出牌回合、或者在扣底）时连问都不问。
 */
export function pickOne(
  selected: Set<string>, hand: SjCard[], card: SjCard, lead: SjShape | null, ctx: SjCtx,
  complete = true,
): Set<string> {
  const next = new Set(selected);
  if (next.has(card.id)) {
    next.delete(card.id);
    return next;
  }
  next.add(card.id);
  if (!complete || !lead) return next;
  const must = hand.filter((c) => next.has(c.id));
  for (const c of forcedCompletion(hand, must, lead, ctx) ?? []) next.add(c.id);
  return next;
}

/**
 * 双击一张牌之后的新选中集：整个单位一起选上或一起放下。
 *
 * 双击的第一下已经走过 `pickOne` 把这张牌切换过一次了，所以「整组是不是已经选上」
 * 看的是**其余那几张** —— 否则整条连对双击一下会又被选回来，放不下。
 */
export function pickUnit(selected: Set<string>, hand: SjCard[], card: SjCard, ctx: SjCtx): Set<string> {
  const ids = unitPickForCard(hand, card, ctx);
  const rest = ids.filter((id) => id !== card.id);
  const next = new Set(selected);
  const allOn = rest.length > 0 && rest.every((id) => next.has(id));
  for (const id of ids) allOn ? next.delete(id) : next.add(id);
  return next;
}

/**
 * 被动建议（`hinted`）什么时候画：只在轮到我、而且我一张都还没选的时候。
 *
 * 一旦开始选牌就撤掉 —— 金色选中态和淡蓝建议描边同时挂在扇子上，
 * 分不清哪个是自己选的；而且已选的牌和建议候选往往根本不兼容。
 */
export function hintedIds(
  myTurn: boolean, selectedCount: number, hintPick: readonly SjCard[] | null,
): Set<string> | undefined {
  if (!myTurn || selectedCount > 0 || !hintPick?.length) return undefined;
  return new Set(hintPick.map((c) => c.id));
}

/** 横扫的模式由**按下的那一张**决定：没选中就是选，已选中就是取消 */
export const sweepModeOf = (selected: Set<string>, id: string): 'add' | 'remove' =>
  (selected.has(id) ? 'remove' : 'add');

/** 横扫提交：扫过的那一段整体选上或整体放下，绝不补齐（用户是一张张扫过来的） */
export function applySweep(selected: Set<string>, ids: string[], mode: 'add' | 'remove'): Set<string> {
  const next = new Set(selected);
  for (const id of ids) mode === 'add' ? next.add(id) : next.delete(id);
  return next;
}

/**
 * 扣底封顶（SELECT-SCENARIOS K1）。
 *
 * 扣底要的是**正好 8 张**，多选一张毫无意义 —— 所以第 9 张干脆点不上，
 * 而不是让它选上去、只把确认按钮变灰（那样玩家得自己数数才知道哪里不对）。
 * 横扫也走这里：能收几张收几张，收不下的那几张原样留着，**已经选上的一张都不动**。
 *
 * @returns `ids` 是真正收得下的那几张；`overflow` 为真表示有牌被挡下来了，调用方该提示一句。
 */
export function kouAdmit(
  selected: Set<string>,
  ids: string[],
  need: number,
): { ids: string[]; overflow: boolean } {
  const take: string[] = [];
  let left = need - selected.size;
  let overflow = false;
  for (const id of ids) {
    if (selected.has(id)) continue;    // 已经在里面的不占额度
    if (left <= 0) { overflow = true; continue; }
    take.push(id);
    left -= 1;
  }
  return { ids: take, overflow };
}

/**
 * 这一手**整手都被规则钉死**时的那一手，否则 null（自动预选与「唯一出法」标注都用它）。
 *
 * 判据是 `forcedCompletion(空集)` 补出的张数正好等于该跟的张数 —— 部分被迫不算。
 */
export function soleFollow(hand: SjCard[], lead: SjShape | null, ctx: SjCtx): SjCard[] | null {
  if (!lead) return null;
  const forced = forcedCompletion(hand, [], lead, ctx);
  return forced && forced.length === lead.count ? forced : null;
}

/**
 * 选的这一手不合法时，**该怪哪几张牌**（界面上给它们描一圈警示色）。
 *
 * 只说明原因，绝不替用户改选择：光一句「有对子必须出对子」找不到是哪几张，
 * 25 张牌的扇子里挨个数太慢了。
 */
export function blameCards(
  hand: SjCard[], selected: SjCard[], lead: SjShape | null, ctx: SjCtx,
): Set<string> {
  const out = new Set<string>();
  if (!lead || !selected.length || validateFollow(hand, lead, selected, ctx).ok) return out;

  const handG = cardsInGroup(hand, lead.group, ctx);
  const sel = new Set(selected.map((c) => c.id));
  const playG = cardsInGroup(selected, lead.group, ctx);
  // 该门没出全（不够就得全出，够了就得全用该门填）：还没选上的该门牌都是问题
  if (handG.length < lead.count || playG.length !== lead.count) {
    for (const c of handG) if (!sel.has(c.id)) out.add(c.id);
    return out;
  }

  // 张数、门都对，那就是结构没跟上：把该出的连对 / 对子指出来
  const req = followRequirement(handG, lead, ctx);
  for (const span of req.tractors) {
    for (const u of allTractors(hand, lead.group, ctx)) {
      if (u.span >= span) for (const c of u.cards) out.add(c.id);
    }
  }
  if (!out.size && req.pairs > 0) {
    for (const u of allPairs(hand, lead.group, ctx)) for (const c of u.cards) out.add(c.id);
  }
  return out;
}

/* -------------------------------------------------------------- 双击整单位 */

/**
 * 双击一张牌要选中的**整个单位**：包含它的最长拖拉机 > 对子 > 这一张。
 *
 * 注意这是**双击**才有的行为，而且和跟牌规则无关 —— 它纯粹是"少点几下"的便利，
 * 不是替玩家做判断。单击永远只动一张牌（被迫补齐除外，见 `shared/sj/complete.ts`），
 * 双击选出来的每一张也都能再单击一张张放下。
 */
export function unitPickForCard(hand: SjCard[], clicked: SjCard, ctx: SjCtx): string[] {
  const group = groupOf(clicked, ctx);
  const tractor = allTractors(hand, group, ctx)
    .filter((u) => u.cards.some((c) => c.id === clicked.id))
    .sort((a, b) => b.span - a.span || a.top - b.top)[0];
  if (tractor) return tractor.cards.map((c) => c.id);
  const pair = allPairs(hand, group, ctx).find((u) => u.cards.some((c) => c.id === clicked.id));
  return pair ? pair.cards.map((c) => c.id) : [clicked.id];
}

/* ------------------------------------------------------------ 提示 / 补齐 */

/**
 * 那颗按钮此刻是什么按钮（DESIGN 3.4）。
 *
 * 一颗按钮三种身份，取决于当前选中态 ——
 * - `hint`：没选牌，给完整的建议出法；
 * - `fill`：选了几张但还凑不成一手，把它补成合法的一手（保留已选的牌）；
 * - `swap`：已经是合法的一手了，换下一种同样合法的打法。
 */
export type SjHintMode = 'hint' | 'fill' | 'swap';

export function hintModeOf(selectedCount: number, ok: boolean): SjHintMode {
  if (selectedCount === 0) return 'hint';
  return ok ? 'swap' : 'fill';
}

export const HINT_LABEL: Record<SjHintMode, string> = { hint: '提示', fill: '补齐', swap: '换一手' };

/**
 * 「补齐」的候选：**包含当前选中牌**的合法整手，好的排前面。
 *
 * 先在机器人给的收益排序 `ranked` 里找超集 —— 那是带了局势判断的顺序，比任何本地
 * 启发式都强。找不到才自己枚举（`legalFollowsContaining`），按"不带分优先、牌小优先"
 * 排序：补齐是在玩家没主意的时候帮他凑一手合法的，默认应该是最保守的垫牌，
 * 而不是替他把大牌扔出去。
 */
export function fillCandidates(
  hand: SjCard[], selected: SjCard[], lead: SjShape | null, ctx: SjCtx,
  ranked: readonly SjCard[][] = [],
): SjCard[][] {
  if (!lead) return [];
  const need = new Set(selected.map((c) => c.id));
  const hits = ranked.filter((cards) => {
    if (cards.length !== lead.count) return false;
    const ids = new Set(cards.map((c) => c.id));
    for (const id of need) if (!ids.has(id)) return false;
    return true;
  });
  if (hits.length) return hits.map((cards) => cards.slice());

  return legalFollowsContaining(hand, selected, lead, ctx)
    .sort((a, b) => sumPoints(a) - sumPoints(b)
      || a.reduce((n, c) => n + cardOrder(c, ctx), 0) - b.reduce((n, c) => n + cardOrder(c, ctx), 0));
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
