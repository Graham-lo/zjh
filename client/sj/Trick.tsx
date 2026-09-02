import { cardFromId, type SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom, SjTrickRecord } from '../../shared/sj/engine.ts';
import { PlayingCard } from '../components/Card.tsx';
import { spotOf, type SjSpot } from './util.ts';

/**
 * 一个座位前的出牌区。多张之间错开 40ms 依次滑入（DESIGN 3.5），
 * 毙的那一手额外闪一下冷钢蓝 —— 全局只有比牌和毙用这个蓝。
 */
export function PlayZone({
  spot,
  cardIds,
  trumped,
  won,
  note,
}: {
  spot: SjSpot;
  cardIds: string[];
  trumped?: boolean;
  won?: boolean;
  note?: string;
}) {
  if (!cardIds.length) return null;
  return (
    <div className={`sj-play sj-play-${spot}${trumped ? ' is-trumped' : ''}${won ? ' is-won' : ''}`}>
      <div className="sj-play-cards">
        {cardIds.map((id, i) => (
          <span key={id} className="sj-play-card" style={{ ['--i' as string]: i }}>
            <PlayingCard card={cardFromId(id)} faceDown={false} size="play" />
          </span>
        ))}
      </div>
      {note && <div className="sj-play-note">{note}</div>}
    </div>
  );
}

/** 亮在座位前的明牌（DESIGN 1.4：亮主的牌明着放到扣底结束） */
export function DeclaredCards({ spot, cards, knocked }: { spot: SjSpot; cards: SjCard[]; knocked?: boolean }) {
  if (!cards.length) return null;
  return (
    <div className={`sj-declared sj-declared-${spot}${knocked ? ' is-knocked' : ''}`}>
      {cards.map((c, i) => (
        <span key={c.id} className="sj-declared-card" style={{ ['--i' as string]: i }}>
          <PlayingCard card={c} faceDown={false} size="play" />
        </span>
      ))}
    </div>
  );
}

/** 「看上一轮」：按住时把上一圈四手牌和赢家摊出来（DESIGN 3.4） */
export function LastTrick({ room, last, mySeat }: { room: SjPublicRoom; last: SjTrickRecord; mySeat: number }) {
  const nameOf = (seat: number) => room.players.find((p) => p.seat === seat)?.name ?? '玩家';
  return (
    <div className="sj-last" aria-hidden="true">
      <div className="sj-last-cap">
        第 {last.trickNo} 圈 · {nameOf(last.winnerSeat)} 收 {last.points} 分
      </div>
      <div className="sj-last-rows">
        {last.plays.map((p) => (
          <div key={p.seat} className={`sj-last-row${p.seat === last.winnerSeat ? ' won' : ''}`}>
            <span className="sj-last-who">
              {nameOf(p.seat)}
              {p.seat === mySeat ? '（我）' : ''}
            </span>
            <span className="sj-last-cards">
              {p.cardIds.map((id, i) => (
                <span key={id} style={{ ['--i' as string]: i }}>
                  <PlayingCard card={cardFromId(id)} faceDown={false} size="tiny" />
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="sj-last-foot">按住不放继续看 · 座位按{spotOf(last.leaderSeat, mySeat) === 'me' ? '我' : '首出者'}起算</div>
    </div>
  );
}
