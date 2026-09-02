/**
 * 升级牌桌客户端的纯计算：出牌按钮的可用性与文案、甩牌失败的提示语、
 * 以及「唯一解自动预选」依赖的那条判据（`suggest` 去重后只剩一种打法）。
 *
 * 这些都跑在 UI 之外，所以能用 node --test 直接钉住 —— 手工点界面复现不了回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPlay, declareOptions, declareVoice, handEndVoice, playVoice, smartPickForCard, throwFailText,
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

/* --------------------------------------------------------- 单击智能联选 */

test('首出单击对子中的任一张，直接预选整对', () => {
  const hand = h('H7a H7b HKa D2a');
  assert.deepEqual(smartPickForCard(hand, hand[0], null, CTX_S5).sort(), ['H7a', 'H7b']);
});

test('首出单击连对中的任一张，优先预选最长完整拖拉机', () => {
  const hand = h('H7a H7b H8a H8b H9a H9b HKa');
  assert.deepEqual(
    smartPickForCard(hand, hand.find((c) => c.id === 'H8a')!, null, CTX_S5).sort(),
    ['H7a', 'H7b', 'H8a', 'H8b', 'H9a', 'H9b'],
  );
});

test('跟拖拉机时单击其中一张，预选一手完整合法连对', () => {
  const hand = h('H6a H6b H7a H7b H8a H8b HKa');
  const lead = parseShape(h('H9a H9b HTa HTb'), CTX_S5)!;
  const picked = smartPickForCard(hand, hand.find((c) => c.id === 'H7a')!, lead, CTX_S5);
  assert.equal(picked.length, 4);
  assert.ok(validateFollow(hand, lead, h(picked.join(' ')), CTX_S5).ok);
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
