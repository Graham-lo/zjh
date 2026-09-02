import type { SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom, SjRoomState } from '../../shared/sj/engine.ts';
import { botKou } from '../../shared/sj/bot.ts';
import { PlayingCard } from '../components/Card.tsx';
import { useCountdown } from '../components/TurnRing.tsx';

const NEED = 8;

/**
 * 扣底（DESIGN 3.4）。
 *
 * 扣底的人这时候手里是 33 张（8 张底牌已经并进来了），要从中挑 8 张扣回去。
 * **不一定是庄家** —— 抄底成功的人也要重新扣一次（DESIGN 1.4b），文案跟着换。
 * 选牌本身走底部那把手牌扇，这里只负责 8 个槽位、`帮我扣` 和 `确认扣底`。
 * `帮我扣` 直接调机器人那套策略 —— 它只读自己的手牌和主花色，客户端算得出来。
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
          // botKou 只读 dealer.hand 与 trump，公开视图就够，不需要别人的手牌
          const fake = { trump: room.trump } as unknown as SjRoomState;
          onFill(botKou(fake, { hand } as never));
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
