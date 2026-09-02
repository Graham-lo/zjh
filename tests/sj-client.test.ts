/**
 * 升级牌桌客户端的纯计算：出牌按钮的可用性与文案、甩牌失败的提示语、
 * 以及「唯一解自动预选」依赖的那条判据（`suggest` 去重后只剩一种打法）。
 *
 * 这些都跑在 UI 之外，所以能用 node --test 直接钉住 —— 手工点界面复现不了回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlay, throwFailText } from '../client/sj/util.ts';
import { suggest, type SjSuggestView } from '../shared/sj/bot.ts';
import { parseShape } from '../shared/sj/units.ts';
import { CTX_S5, h } from './sj-helpers.ts';

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
