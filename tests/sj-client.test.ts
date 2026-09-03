/**
 * 升级牌桌客户端的纯计算：出牌按钮的可用性与文案、甩牌失败的提示语、
 * 以及「唯一解自动预选」依赖的那条判据（`suggest` 去重后只剩一种打法）。
 *
 * 这些都跑在 UI 之外，所以能用 node --test 直接钉住 —— 手工点界面复现不了回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applySweep, blameCards, checkPlay, declareOptions, declareVoice, fillCandidates, handEndVoice,
  hintModeOf, hintedIds, kouAdmit, pickOne, pickUnit, playVoice, soleFollow, sweepModeOf,
  throwFailText,
  unitPickForCard,
} from '../client/sj/util.ts';
import { SJ_VOICE_LINES, ZJH_VOICE_LINES } from '../client/voice-lines.ts';
import { suggest, type SjSuggestView } from '../shared/sj/bot.ts';
import { applySjCommand, timeoutKou, type SjPublicRoom } from '../shared/sj/engine.ts';
import { parseShape } from '../shared/sj/units.ts';
import { declarationOptions, validateFollow } from '../shared/sj/rules.ts';
import { CTX_S5, h, makeSjRoom, mulberry32, runDeclaring } from './sj-helpers.ts';

/* --------------------------------------------------------- 出牌按钮 */

test('首出甩牌不会被客户端拦下：按钮点得亮，甩不甩得成由服务端裁决', () => {
  const hand = h('HAa HKa H2a S6a');
  // 甩牌能不能成立要看别人的手牌，客户端无从预判 —— 所以这里只能放行，
  // 否则玩家会看到「出牌」永远灰着，误以为"甩牌不能出"。
  const throwTwo = checkPlay(hand, h('HAa HKa'), null, CTX_S5);
  assert.equal(throwTwo.ok, true);
  assert.equal(throwTwo.label, '甩牌 2 张');
  assert.equal(parseShape(h('HAa HKa'), CTX_S5)?.isThrow, true);

  const throwThree = checkPlay(hand, h('HAa HKa H2a'), null, CTX_S5);
  assert.equal(throwThree.ok, true);
  assert.equal(throwThree.label, '甩牌 3 张');
});

test('跨花色组的首出才该灰掉，并说明原因', () => {
  const hand = h('HAa S6a');
  const bad = checkPlay(hand, h('HAa S6a'), null, CTX_S5);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /同一个花色组/);
});

test('甩牌失败的提示先说打出了什么，再说退回了几张', () => {
  const msg = throwFailText(['H2a'], 2);
  assert.match(msg, /已强制打出 ♥2/);
  assert.match(msg, /其余 2 张退回手里/);
  // 一个单位都没退回时不该硬凑一句「其余 0 张」
  assert.ok(!throwFailText(['HKa', 'HKb'], 0).includes('其余'));
});

/* ----------------------------------------------- 唯一解自动预选的判据 */

const view = (leadIds: string[]): SjSuggestView => ({
  trump: { suit: 'S', level: 5 },
  trick: [{ seat: 0, cardIds: leadIds }],
  playedIds: [],
  // 0 号首出、我坐 1 号：领先的是对手不是对家
  mySeat: 1,
  trickNo: 1,
});

test('跟牌只剩一种打法时，建议列表只有一项 —— 这一手可以直接替玩家预选', () => {
  // 首出一张红桃，我手里只剩一张红桃：有 G 必跟 G，别无选择
  const only = suggest(view(['H3a']), h('HAa SKa SQa'));
  assert.equal(only.length, 1);
  assert.deepEqual(only[0].map((c) => c.id), ['HAa']);

  // 首出一对红桃，我手里正好一对：必须整对跟出
  const pair = suggest(view(['H3a', 'H3b']), h('HAa HAb SKa'));
  assert.equal(pair.length, 1);
  assert.deepEqual(pair[0].map((c) => c.id).sort(), ['HAa', 'HAb']);
});

test('还有得选的时候建议不止一项 —— 不会替玩家做决定', () => {
  const many = suggest(view(['H3a']), h('HAa H2a SKa'));
  assert.ok(many.length > 1, '出大出小是两种打法，得让玩家自己挑');
});

/* ------------------------------------------- 抄底按钮与服务端同源（1.4b） */

/**
 * 这条是「抄底按钮能点的，服务端一定接受」那句承诺的看门人。
 *
 * 对真实牌局里每一个被问到抄底的人，把抄底条会画出来的按钮逐个拿去给服务端跑一遍：
 * 列出来的必须全收，没列出来的（但形式合法的亮法）必须全拒。
 * 两边只要有一处各写各的，这里立刻就红。
 */
test('抄底条上点得亮的每一手服务端都收得下，没画出来的一手都收不下', () => {
  let accepted = 0;
  let rejected = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const room = makeSjRoom('sj_510k');
    const o = { rng: mulberry32(seed), now: 1_700_000_000_000 };
    applySjCommand(room, room.hostId, { type: 'start' }, o);
    runDeclaring(room, o);
    timeoutKou(room, o); // 庄家扣完底 → 抄底询问

    let guard = 0;
    while (room.phase === 'chao') {
      assert.ok(guard++ < 10, `seed=${seed}：询问没有收敛`);
      const asked = room.players[room.chaoSeat!];
      const shown = declareOptions(asked.hand, room.trump, asked.id, 'chao');
      const shownKeys = new Set(shown.map((x) => x.cardIds.slice().sort().join(',')));

      for (const opt of shown) {
        // 在副本上试，免得把主线程的这一局改掉
        const clone = structuredClone(room);
        applySjCommand(clone, asked.id, { type: 'chao', cardIds: opt.cardIds }, o);
        assert.equal(clone.phase, 'kou', `seed=${seed}：抄成了就该轮到他重新扣底`);
        assert.equal(clone.kouSeat, asked.seat);
        accepted += 1;
      }
      // 手里做得到、但按钮没画出来的那些，服务端必须拒绝
      for (const opt of declarationOptions(asked.hand, room.trump.level)) {
        const key = opt.cards.map((c) => c.id).sort().join(',');
        if (shownKeys.has(key)) continue;
        const clone = structuredClone(room);
        assert.throws(
          () => applySjCommand(clone, asked.id, { type: 'chao', cardIds: opt.cards.map((c) => c.id) }, o),
          `seed=${seed}：${key} 没画在抄底条上，服务端却收了`,
        );
        rejected += 1;
      }
      applySjCommand(room, asked.id, { type: 'pass_chao' }, o);
    }
    assert.equal(room.phase, 'playing', `seed=${seed}：全员不抄就该开打`);
  }
  assert.ok(accepted > 0, '一次都没抄成过，这条用例什么都没验到');
  assert.ok(rejected > 0, '一次都没拒过，反向那一半没验到');
});

/* ------------------------------------------------------- 双击整单位 */

test('双击对子里的任一张，选中整对', () => {
  const hand = h('H7a H7b HKa D2a');
  assert.deepEqual(unitPickForCard(hand, hand[0], CTX_S5).sort(), ['H7a', 'H7b']);
});

test('双击连对里的任一张，选中包含它的最长拖拉机', () => {
  const hand = h('H7a H7b H8a H8b H9a H9b HKa');
  assert.deepEqual(
    unitPickForCard(hand, hand.find((c) => c.id === 'H8a')!, CTX_S5).sort(),
    ['H7a', 'H7b', 'H8a', 'H8b', 'H9a', 'H9b'],
  );
});

test('双击一张没伴的牌，只选它自己 —— 双击也不做"智能整手"', () => {
  const hand = h('H7a H9a HKa D2a');
  assert.deepEqual(unitPickForCard(hand, hand.find((c) => c.id === 'H9a')!, CTX_S5), ['H9a']);
});

/* ------------------------------------------------------- 提示 / 补齐 / 换一手 */

test('一颗按钮三种身份：没选牌是提示，选了不合法是补齐，合法了是换一手', () => {
  assert.equal(hintModeOf(0, false), 'hint');
  assert.equal(hintModeOf(0, true), 'hint');
  assert.equal(hintModeOf(2, false), 'fill');
  assert.equal(hintModeOf(2, true), 'swap');
});

test('补齐只在包含已选牌的合法整手里找，且一张都不动已选的牌', () => {
  const hand = h('H7a H9a HTa HJa HKa S6a D2a');
  const lead = parseShape(h('HAa HKb HQa'), CTX_S5)!;
  const picked = h('H7a');
  const cands = fillCandidates(hand, picked, lead, CTX_S5);
  assert.ok(cands.length > 1, '这个局面有多种垫法，补齐不该只给一种');
  for (const play of cands) {
    assert.ok(play.some((c) => c.id === 'H7a'), '补齐把玩家已经选的牌弄丢了');
    assert.ok(validateFollow(hand, lead, play, CTX_S5).ok);
  }
  // 默认最保守：不带分、牌小的排在最前
  assert.equal(cands[0].some((c) => c.id === 'HKa'), false, '第一候选不该主动把 K 送出去');
});

test('补齐优先采用机器人给的收益排序里包含已选牌的那一手', () => {
  const hand = h('H7a H9a HTa HJa HKa S6a D2a');
  const lead = parseShape(h('HAa HKb HQa'), CTX_S5)!;
  const ranked = [h('H7a HKa HJa'), h('H9a HTa HJa')];
  const cands = fillCandidates(hand, h('H7a'), lead, CTX_S5, ranked);
  assert.deepEqual(cands.map((p) => p.map((c) => c.id)), [['H7a', 'HKa', 'HJa']]);
});

test('这几张凑不成一手时补齐给不出候选，调用方据此提示而不是偷偷改选中态', () => {
  // 有对必出对：带着 H9a 的三张里凑不出合法跟牌
  const hand = h('H7a H7b H9a S6a D2a');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  assert.deepEqual(fillCandidates(hand, h('H9a'), lead, CTX_S5), []);
});

/* ================================================================
 * 选牌场景清单（docs/shengji/SELECT-SCENARIOS.md）
 *
 * 编号一一对应，改交互之前先看这一段：这里钉住的是"手感"，
 * 而手感回归在界面上很难被发现 —— 点一下多选了三张，人往往只觉得"怪"，说不出哪里怪。
 * ================================================================ */

/** 选中集写成 id 排序数组，断言读起来才像人话 */
const sel = (s: Set<string>) => [...s].sort();
const S = (...ids: string[]) => new Set(ids);

/* ------------------------------------------------------- §1 首出 */

test('S1 首出点一张牌只选这一张，再点就取消', () => {
  const hand = h('H7a H7b H8a HKa D2a');
  const one = pickOne(S(), hand, hand[0], null, CTX_S5);
  assert.deepEqual(sel(one), ['H7a']);
  assert.deepEqual(sel(pickOne(one, hand, hand[0], null, CTX_S5)), []);
});

test('S2 首出点对子里的一张不会自动成对，双击才成对', () => {
  const hand = h('H7a H7b HKa D2a');
  const one = pickOne(S(), hand, hand[0], null, CTX_S5);
  assert.deepEqual(sel(one), ['H7a']);
  assert.deepEqual(sel(pickUnit(one, hand, hand[0], CTX_S5)), ['H7a', 'H7b']);
});

test('S3 首出点拖拉机里的一张也只选这一张，不自动扩成拖拉机', () => {
  const hand = h('H7a H7b H8a H8b H9a H9b HKa');
  const c = hand.find((x) => x.id === 'H8a')!;
  assert.deepEqual(sel(pickOne(S(), hand, c, null, CTX_S5)), ['H8a']);
});

test('S4 横扫：模式由按下的那一张决定，往回扫就撤销', () => {
  const row = ['H7a', 'H7b', 'H8a', 'H8b', 'H9a'];
  // 按在没选中的牌上 = 这一趟是"选"
  assert.equal(sweepModeOf(S(), 'H7a'), 'add');
  const five = applySweep(S(), row, 'add');
  assert.deepEqual(sel(five), row.slice().sort());
  // 按在已选中的牌上 = 这一趟是"取消"
  assert.equal(sweepModeOf(five, 'H7a'), 'remove');
  assert.deepEqual(sel(applySweep(five, row.slice(0, 3), 'remove')), ['H8b', 'H9a']);
  // 拖动过程中每次都从"按下时的那一份"重算，所以往回拖是撤销而不是越拖越多
  assert.deepEqual(sel(applySweep(S(), row.slice(0, 2), 'add')), ['H7a', 'H7b']);
});

test('K1 扣底选满 8 张之后第 9 张收不下，已经选上的一张都不动', () => {
  const eight = S('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const nine = kouAdmit(eight, ['i'], 8);
  assert.deepEqual(nine, { ids: [], overflow: true }, '第 9 张必须点不上，而且要给得出提示');
  // 已经在里面的不占额度：重新点一张已选的牌不会被当成"又要加一张"
  assert.deepEqual(kouAdmit(eight, ['c'], 8), { ids: [], overflow: false });
});

test('K3 扣底横扫扫过头：能收的先收下，只有被截断的那几张算 overflow', () => {
  const six = S('a', 'b', 'c', 'd', 'e', 'f');
  // 扫过 c d e f g h i（其中 cdef 已经在里面）：只剩 2 个额度，收 g h，i 被挡下
  const got = kouAdmit(six, ['c', 'd', 'e', 'f', 'g', 'h', 'i'], 8);
  assert.deepEqual(got, { ids: ['g', 'h'], overflow: true });
  // 正好扫满不算 overflow：不该为了"刚好选满"弹一句提示
  assert.deepEqual(kouAdmit(six, ['g', 'h'], 8), { ids: ['g', 'h'], overflow: false });
});

test('S5 提示填进来的一手，每一张都还能单独点掉', () => {
  const hand = h('H7a H7b H8a H8b HKa D2a');
  const filled = S('H7a', 'H7b', 'H8a', 'H8b');
  const after = pickOne(filled, hand, hand.find((c) => c.id === 'H8a')!, null, CTX_S5);
  assert.deepEqual(sel(after), ['H7a', 'H7b', 'H8b'], '系统选的牌必须放得下');
});

test('S6 首出跨花色组：按钮灰、说明原因，不替用户改', () => {
  const hand = h('HAa S6a');
  const bad = checkPlay(hand, h('HAa S6a'), null, CTX_S5);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /同一个花色组/);
});

test('S7 同门 A A K 可以甩，按之前先说清罚分风险', () => {
  const hand = h('HAa HAb HKa H2a');
  const out = checkPlay(hand, h('HAa HAb HKa'), null, CTX_S5);
  assert.equal(out.ok, true, '甩得成不成由服务端裁决，客户端不能拦');
  assert.equal(out.label, '甩牌 3 张');
  assert.match(out.note, /罚 10 分/);
});

/* ------------------------------------------------------- §2 跟牌 */

/** 跟牌场景的公共写法：点一张之后的选中集 */
function follow(handSpec: string, clicked: string, leadSpec: string, from: string[] = []): string[] {
  const hand = h(handSpec);
  const lead = parseShape(h(leadSpec), CTX_S5)!;
  const card = hand.find((c) => c.id === clicked)!;
  return sel(pickOne(new Set(from), hand, card, lead, CTX_S5));
}

test('F1 首出单张：点该门任一张都合法；点别门牌不合法且说明原因', () => {
  const hand = h('H7a H9a S6a D2a');
  const lead = parseShape(h('HAa'), CTX_S5)!;
  assert.deepEqual(follow('H7a H9a S6a D2a', 'H7a', 'HAa'), ['H7a'], '该门有两张，规则不强迫哪一张');
  assert.equal(checkPlay(hand, h('H7a'), lead, CTX_S5).ok, true);

  assert.deepEqual(follow('H7a H9a S6a D2a', 'D2a', 'HAa'), ['D2a'], '不合法也只加这一张，不替用户改');
  const bad = checkPlay(hand, h('D2a'), lead, CTX_S5);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /红桃/);
});

test('F2 首出对子、我有该门对子：点一张补上它的另一半，第二对一张不碰', () => {
  // 一对：只有这一条路
  assert.deepEqual(follow('H7a H7b H9a HKa D2a', 'H7a', 'HAa HAb'), ['H7a', 'H7b']);
  // 两对：包含 H7a 的合法出法仍然只有 {77} 一种，所以补的还是另一半 ——
  // 但**绝不会**把第二对也扫进来（那才是"智能选牌"）。见 tests/sj-complete.test.ts 里的说明
  assert.deepEqual(follow('H7a H7b H9a H9b D2a', 'H7a', 'HAa HAb'), ['H7a', 'H7b']);
});

test('F3 首出对子、我该门只有 2 张单张：点一张补齐唯一的另一张', () => {
  assert.deepEqual(follow('H7a H9a S6a D2a', 'H7a', 'HAa HAb'), ['H7a', 'H9a']);
});

test('F4 首出对子、我该门 3 张单张无对：点一张不补，选满 2 张按钮才亮', () => {
  assert.deepEqual(follow('H7a H9a HKa S6a', 'H7a', 'HAa HAb'), ['H7a']);
  const hand = h('H7a H9a HKa S6a');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  assert.equal(checkPlay(hand, h('H7a'), lead, CTX_S5).ok, false);
  assert.equal(checkPlay(hand, h('H7a H9a'), lead, CTX_S5).ok, true);
});

test('F5 首出拖拉机：唯一同长连对时补齐整条，有多条候选时只补另一半', () => {
  assert.deepEqual(
    follow('H7a H7b H8a H8b H9a HQa', 'H7a', 'HAa HAb HKa HKb'),
    ['H7a', 'H7b', 'H8a', 'H8b'],
    '唯一一条二连对，整条都躲不开',
  );
  assert.deepEqual(
    follow('H7a H7b H8a H8b H9a H9b HKa', 'H8a', 'HTa HTb HJa HJb'),
    ['H8a', 'H8b'],
    '三连对有两种拆法，只有 H8b 是两种拆法都带的',
  );
});

test('F6 首出拖拉机、该门有对子但连不成：补法唯一才补，否则等用户', () => {
  // 两个对子，拖拉机降级成两个对子槽 —— 两对都得出，唯一解
  assert.deepEqual(
    follow('H7a H7b HQa HQb H2a S6a', 'H7a', 'HAa HAb HKa HKb'),
    ['H7a', 'H7b', 'HQa', 'HQb'],
  );
  // 三个对子：填哪两对是用户的事，只补另一半
  assert.deepEqual(
    follow('H7a H7b HQa HQb H3a H3b S6a', 'H7a', 'HAa HAb HKa HKb'),
    ['H7a', 'H7b'],
  );
});

test('F7 首出 n 张、我该门正好 n 张：点任一张补齐全部', () => {
  assert.deepEqual(follow('H7a H9a HKa S6a D2a', 'H9a', 'HAa HAb HQa'), ['H7a', 'H9a', 'HKa']);
});

test('F8 首出 n 张、我该门不够 n 张：补齐该门全部，垫哪张不管', () => {
  assert.deepEqual(follow('H7a H9a S6a S8a D2a', 'H7a', 'HAa HKa HQa'), ['H7a', 'H9a']);
});

test('F9 缺门：主牌副牌混着垫都行，一张都不补', () => {
  assert.deepEqual(follow('S6a S8a D2a D3a', 'S6a', 'HAa HKa'), ['S6a']);
  const hand = h('S6a S8a D2a D3a');
  const lead = parseShape(h('HAa HKa'), CTX_S5)!;
  assert.equal(checkPlay(hand, h('S6a D2a'), lead, CTX_S5).ok, true, '缺门时混着垫是合法的');
});

test('F10 缺门点一张主牌不会自动凑成"毙"；主牌正好 n 张时才补', () => {
  assert.deepEqual(follow('S6a S7a D2a D3a', 'S6a', 'HAa HKa'), ['S6a'], '还能垫副牌，不强迫');
  assert.deepEqual(follow('S6a S7a', 'S6a', 'HAa HKa'), ['S6a', 'S7a'], '手里就这两张，躲不开');
  const hand = h('S6a S7a D2a D3a');
  const lead = parseShape(h('HAa HKa'), CTX_S5)!;
  const bi = checkPlay(hand, h('S6a S7a'), lead, CTX_S5);
  assert.equal(bi.ok, true);
  assert.match(bi.note, /毙/);
});

test('F11 甩牌首出（对 + 单）：对子槽唯一就补对子，填充槽绝不自动填', () => {
  assert.deepEqual(follow('H7a H7b H9a HTa S6a', 'H7a', 'HAa HAb HKa'), ['H7a', 'H7b']);
});

test('F12 有对子却出两张单：按钮灰、说清原因，并指出该怪哪几张', () => {
  const hand = h('H7a H7b H9a HTa S6a');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  const bad = checkPlay(hand, h('H9a HTa'), lead, CTX_S5);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /对子/);
  assert.deepEqual(sel(blameCards(hand, h('H9a HTa'), lead, CTX_S5)), ['H7a', 'H7b']);
  // 合法的一手不该怪任何人
  assert.deepEqual(sel(blameCards(hand, h('H7a H7b'), lead, CTX_S5)), []);
});

test('F13 唯一合法解：整手被迫时才算，用户点掉还能点回来', () => {
  const hand = h('H7a H7b HKa D2a');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  const only = soleFollow(hand, lead, CTX_S5);
  assert.deepEqual(only!.map((c) => c.id).sort(), ['H7a', 'H7b']);
  // 部分被迫不算唯一解：该门 3 张单张，填哪两张是用户的事
  assert.equal(soleFollow(h('H7a H9a HKa S6a'), lead, CTX_S5), null);
  // 点掉一张再点回来，回到同一手
  const off = pickOne(S('H7a', 'H7b'), hand, hand[0], lead, CTX_S5);
  assert.deepEqual(sel(off), ['H7b']);
  assert.deepEqual(sel(pickOne(off, hand, hand[0], lead, CTX_S5)), ['H7a', 'H7b']);
});

test('F14 先选 2 张再点提示：整个选择被替换成一手完整候选，且含原来那 2 张', () => {
  const hand = h('H7a H9a HTa HJa HKa S6a D2a');
  const lead = parseShape(h('HAa HKb HQa'), CTX_S5)!;
  const picked = h('H7a H9a');
  const [first] = fillCandidates(hand, picked, lead, CTX_S5);
  assert.equal(first.length, lead.count, '换上来的是完整的一手，不是零头');
  for (const c of picked) assert.ok(first.some((x) => x.id === c.id), '用户已经选的牌被弄丢了');
});

test('F15 选择非空时不画被动建议，免得两种描边混在一起', () => {
  const pick = h('H7a H7b');
  assert.deepEqual(sel(hintedIds(true, 0, pick)!), ['H7a', 'H7b']);
  assert.equal(hintedIds(true, 1, pick), undefined);
  assert.equal(hintedIds(false, 0, pick), undefined);
  assert.equal(hintedIds(true, 0, null), undefined);
});

/* --------------------------------------------------------- 语音（DESIGN 3.6） */

/** playVoice 只读这几个字段，其余的牌桌状态与它无关 */
function voiceRoom(
  trick: { seat: number; cardIds: string[] }[],
  handCounts: number[] = [10, 10, 10, 10],
): SjPublicRoom {
  return {
    trump: { suit: 'S', level: 5 },
    trick,
    lastTrick: trick.length >= 4 ? { plays: trick } : null,
    players: handCounts.map((handCount, seat) => ({ id: `p${seat}`, seat, handCount })),
  } as unknown as SjPublicRoom;
}

test('两个游戏的台词表没有一个 key 重合，升级借不到炸金花的话', () => {
  const shared = Object.keys(SJ_VOICE_LINES).filter((k) => k in ZJH_VOICE_LINES);
  assert.deepEqual(shared, []);
  // 「轮到你了」这句每局要念几十遍，两张表里都不该再有
  assert.ok(!('turn' in ZJH_VOICE_LINES) && !('turn' in SJ_VOICE_LINES));
  assert.ok(Object.keys(SJ_VOICE_LINES).every((k) => k.startsWith('sj_')));
});

test('亮主的连读：单张报花色，对子先报「一对」，反主和抄底各自带一句', () => {
  assert.deepEqual(declareVoice({ trump: 'H', strength: 1 }), ['sj_trump_h']);
  assert.deepEqual(declareVoice({ trump: 'S', strength: 5 }), ['sj_trump_pair', 'sj_trump_s']);
  assert.deepEqual(declareVoice({ trump: 'NT', strength: 7 }), ['sj_nt']);
  assert.deepEqual(declareVoice({ trump: 'D', strength: 2, reinforce: true }), ['sj_reinforce']);
  assert.deepEqual(declareVoice({ trump: 'C', strength: 3 }, { override: true }), ['sj_fanzhu', 'sj_trump_c']);
  assert.deepEqual(declareVoice({ trump: 'S', strength: 5 }, { chao: true }), ['sj_chao', 'sj_trump_s']);
});

test('出牌只在有信息量的时刻出声：首出报牌型与吊主，跟牌只报毙与垫分', () => {
  const lead = (cardIds: string[], unit: 'single' | 'pair' | 'tractor' | 'throw', counts?: number[]) =>
    playVoice(voiceRoom([{ seat: 0, cardIds }], counts), { playerId: 'p0', cardIds, unit, trumped: false });

  assert.deepEqual(lead(['SAa'], 'single'), ['sj_diao']);          // 首出主牌 = 吊主
  assert.deepEqual(lead(['HAa', 'HAb'], 'pair'), ['sj_pair']);
  assert.deepEqual(lead(['HAa'], 'single'), []);                    // 副牌小单张不值得出声
  // 首出之后手里就空了，只可能是最后一圈
  assert.deepEqual(lead(['HAa', 'HAb'], 'pair', [0, 4, 4, 4]), ['sj_last', 'sj_pair']);

  // 毙 / 盖毙：本圈之前有没有人先毙过
  const bi = voiceRoom([{ seat: 0, cardIds: ['HAa'] }, { seat: 1, cardIds: ['S6a'] }]);
  assert.deepEqual(playVoice(bi, { playerId: 'p1', cardIds: ['S6a'], unit: 'single', trumped: true }), ['sj_bi']);
  const gai = voiceRoom([
    { seat: 0, cardIds: ['HAa'] }, { seat: 1, cardIds: ['S6a'] }, { seat: 2, cardIds: ['S7a'] },
  ]);
  assert.deepEqual(playVoice(gai, { playerId: 'p2', cardIds: ['S7a'], unit: 'single', trumped: true }), ['sj_gaibi']);

  // 跟不上：垫出去带分才出声，垫张废牌是安静的
  const dian = voiceRoom([{ seat: 0, cardIds: ['HAa'] }, { seat: 1, cardIds: ['CKa'] }]);
  assert.deepEqual(playVoice(dian, { playerId: 'p1', cardIds: ['CKa'], unit: 'single', trumped: false }), ['sj_dian']);
  const quiet = voiceRoom([{ seat: 0, cardIds: ['HAa'] }, { seat: 1, cardIds: ['C9a'] }]);
  assert.deepEqual(playVoice(quiet, { playerId: 'p1', cardIds: ['C9a'], unit: 'single', trumped: false }), []);
});

test('结算的连读分清大光小光、上台与守住', () => {
  assert.deepEqual(handEndVoice({ defendersWin: false, up: 3, label: '大光' }), ['sj_daguang']);
  assert.deepEqual(handEndVoice({ defendersWin: false, up: 2, label: '小光' }), ['sj_xiaoguang']);
  assert.deepEqual(handEndVoice({ defendersWin: false, up: 1, label: '庄家升一级' }), ['sj_shouzhu', 'sj_levelup']);
  assert.deepEqual(handEndVoice({ defendersWin: true, up: 0, label: '闲家上台' }), ['sj_shangtai']);
  assert.deepEqual(handEndVoice({ defendersWin: true, up: 2, label: '上台 · 升两级' }), ['sj_shangtai', 'sj_levelup']);
});

/* --------------------------------------------- 布局回归：选牌不许把牌挪走 */

/**
 * 这两条只能读源码钉：node --test 里没有 DOM，量不到布局。
 * 但它们都是**真的踩过的坑**，而且都是一改就复发的那种，所以宁可用静态检查兜住。
 */
test('手牌的状态类名必须带 sj- 前缀：全局 .hint 会把被提示的牌压下去 12px', async () => {
  const src = await readFile(new URL('../client/sj/Hand.tsx', import.meta.url), 'utf8');
  // 全局 styles.css 里 `.hint { margin: 12px 0 0 }`、将来还可能有别的裸类名，
  // 一旦命中就是「提示一出现整行手牌错位」，横扫会从手指底下溜走
  assert.ok(!/['"` ](hint|blame)['"` ]/.test(src), 'Hand.tsx 里出现了不带 sj- 前缀的 hint/blame 类名');
  assert.match(src, /' sj-hint'/);
  assert.match(src, /' sj-blame'/);
});

test('出牌条下方的说明只有一行、而且永远占位，长高了会把手牌顶下去', async () => {
  const tsx = await readFile(new URL('../client/sj/SjTable.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../client/sj.css', import.meta.url), 'utf8');
  // 三条说明（不合法的原因 / 打法提醒 / 唯一出法）必须是同一个三元链，不能各自成行
  assert.equal((tsx.match(/className="sj-why-slot"/g) ?? []).length, 1);
  assert.ok(!/<div className="sj-why"/.test(tsx), 'sj-why 应当是 slot 里的 span，不能自己占一个 div');
  // 占位高度和行高必须成对出现，且数字对得上，否则空/满两态差几个像素
  for (const [slot, line] of [['18px', '18px'], ['20px', '20px']]) {
    assert.ok(css.includes(`min-height: ${slot}`), `sj.css 少了 min-height: ${slot}`);
    assert.ok(css.includes(`line-height: ${line}`), `sj.css 少了 line-height: ${line}`);
  }
});
