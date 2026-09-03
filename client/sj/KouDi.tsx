import type { SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom } from '../../shared/sj/engine.ts';
import { botKou } from '../../shared/sj/bot.ts';
import { PlayingCard } from '../components/Card.tsx';
import { useCountdown } from '../components/TurnRing.tsx';

/**
 * 扣底要的张数。**导出**给 SjTable —— 封顶（第 9 张点不上）要在选牌那一侧拦，
 * 但「8」这个数只能有一个出处，就是这里（SELECT-SCENARIOS K1）。
 */
export const KOU_NEED = 8;
const NEED = KOU_NEED;

/**
 * 扣底（DESIGN 3.4）。
 *
 * 扣底的人这时候手里是 33 张（8 张底牌已经并进来了），要从中挑 8 张扣回去。
 * **不一定是庄家** —— 抄底成功的人也要重新扣一次（DESIGN 1.4b），文案跟着换。
 * 选牌本身走底部那把手牌扇 —— 单击、双击、按住横扫全是同一套 `Hand` 逻辑，
 * 扣底阶段一样能用；这里只负责 8 个槽位、`帮我扣` 和 `确认扣底`。
 * 选满 8 张之后第 9 张点不上（封顶在 `SjTable` 的 `pickCard` / `sweep` 里，用的就是 `KOU_NEED`）。
 * `帮我扣` 直接调机器人那套策略，并且把整个 `room` 递进去 —— 记牌器读的全是公开信息，
 * 客户端算得出来，所以真人拿到的建议和电脑代扣一模一样（`tests/sj-bot.test.ts` 有一致性用例）。
 */
export function KouDi({
  room,
  hand,
  selected,
  onFill,
  onConfirm,
}: {
  room: SjPublicRoom;
  hand: SjCard[];
  selected: SjCard[];
  onFill(ids: string[]): void;
  onConfirm(): void;
}) {
  const left = useCountdown(room.turnDeadline);
  const ok = selected.length === NEED;
  const afterChao = room.kouSeat !== room.dealerSeat || room.chaoDirty;

  return (
    <div className="sj-bar sj-kou">
      <span className="sj-bar-cap">
        {afterChao ? '你抄了底，重新扣 ' : '扣下 '}
        <b>{selected.length}</b> / {NEED}
      </span>
      <div className="sj-slots">
        {Array.from({ length: NEED }, (_, i) => (
          <span key={selected[i]?.id ?? `slot-${i}`} className={`sj-slot${selected[i] ? ' filled' : ''}`}>
            {selected[i] ? <PlayingCard card={selected[i]} faceDown={false} size="play" /> : null}
          </span>
        ))}
      </div>
      <button
        className="btn ghost"
        onClick={() => {
          // 整个房间都递给大脑：记牌器读的全是公开信息（谁亮过什么、各门场外还剩几张、
          // 底里那 8 张 —— 扣底阶段只有我自己看得见），别人的 `hand` 在公开视图里是空数组，
          // 大脑本来就不该读。这样「帮我扣」和电脑代扣走的是同一条路，
          // B6「扣光上一个亮主者那门」和 C6「闲家抄成底埋 K/10」对真人一样生效。
          const me = room.players.find((p) => p.id === room.viewerId);
          onFill(botKou(room, { seat: me?.seat ?? room.kouSeat, hand, declaredIds: me?.declaredIds }));
        }}
      >
        帮我扣
      </button>
      <button className="btn primary" disabled={!ok} onClick={onConfirm}>
        确认扣底
      </button>
      <span className="sj-bar-hint">
        还剩 <b>{left}s</b> · 超时由电脑代扣。底牌被闲家最后一圈拿走要翻倍算分，主牌和分牌别轻易扣
      </span>
    </div>
  );
}

/** 别人视角的扣底：只看到 8 张牌背飞向扣底的人和一个倒计时 */
export function KouWaiting({ room }: { room: SjPublicRoom }) {
  const left = useCountdown(room.turnDeadline);
  // 抄底之后拿底牌的不是庄家（DESIGN 1.4b），所以这里认 kouSeat
  const burier = room.players.find((p) => p.seat === room.kouSeat);
  const afterChao = room.kouSeat !== room.dealerSeat || room.chaoDirty;
  return (
    <div className="sj-bar sj-kou-wait">
      <span className="sj-bar-cap">扣底中</span>
      <span className="sj-bar-note">
        {burier?.name ?? '庄家'} {afterChao ? '抄走了底牌' : '拿到 8 张底牌'}，正在扣回 8 张 ·
        还剩 <b>{left}s</b>
      </span>
    </div>
  );
}
