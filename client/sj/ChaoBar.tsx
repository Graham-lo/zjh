import type { SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom } from '../../shared/sj/engine.ts';
import { useCountdown } from '../components/TurnRing.tsx';
import { declareOptions, suitName, trumpText } from './util.ts';

/**
 * 抄底条（DESIGN 3.4 / 1.4b）。
 *
 * 庄家扣完底之后，从庄家下家起顺时针一个一个问：要不要亮一手比现在更强的牌，
 * 把底牌抄过来重扣。按钮列表来自 `declareOptions(..., 'chao')` —— 和服务端的
 * `doChao` 是同一条判据，所以这里点得亮的，服务端一定收得下。
 *
 * 不能自反那一条在判据里：轮到当前亮主者时，他手上只会剩「对王反成无主」这一种按钮。
 */
export function ChaoBar({
  room,
  hand,
  onChao,
  onPass,
}: {
  room: SjPublicRoom;
  hand: SjCard[];
  onChao(cardIds: string[]): void;
  onPass(): void;
}) {
  const left = useCountdown(room.turnDeadline);
  const asked = room.players.find((p) => p.seat === room.chaoSeat);
  const mine = !!asked && asked.id === room.viewerId;
  const options = mine ? declareOptions(hand, room.trump, room.viewerId, 'chao') : [];
  const iAmDeclarer = room.trump.declarerId === room.viewerId;

  if (!mine) {
    return (
      <div className="sj-bar sj-chao-wait">
        <span className="sj-bar-cap">抄底询问</span>
        <span className="sj-bar-note">
          正在问 {asked?.name ?? '玩家'} 是否抄底 · 还剩 <b>{left}s</b>
        </span>
        <span className="sj-bar-hint">
          {trumpText(room.trump.suit, room.trump.level)} · 谁亮出更强的一手，就把底牌抄走重扣
        </span>
      </div>
    );
  }

  return (
    <div className="sj-bar sj-chao">
      <span className="sj-bar-cap">
        轮到你 · 抄底？还剩 <b>{left}s</b>
      </span>

      {options.map((o) => (
        <button
          key={o.key}
          className={`btn ${o.trump === 'NT' ? 'sj-nt' : 'sj-suit'} sj-declare-btn`}
          data-suit={o.trump}
          onClick={() => onChao(o.cardIds)}
          title={`亮${suitName(o.trump)}抄底，拿走 8 张底牌重扣`}
        >
          <span className="sj-declare-glyph">{o.glyph}</span>
          <span className="sj-declare-note">{o.note}</span>
        </button>
      ))}

      {!options.length && (
        <span className="sj-bar-note">
          {iAmDeclarer ? '主是你亮的，不能自己抄自己 —— 除非用对王反成无主' : '你手里没有比现在更强的牌'}
        </span>
      )}

      <button className="btn ghost" onClick={onPass}>
        不抄
      </button>

      <span className="sj-bar-hint">
        抄底会拿走 8 张底牌重扣，并把主变成你亮的花色 · 超时算不抄
      </span>
    </div>
  );
}
