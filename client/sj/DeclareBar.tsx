import type { SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom } from '../../shared/sj/engine.ts';
import { useCountdown } from '../components/TurnRing.tsx';
import { declareOptions, suitName, trumpGlyph } from './util.ts';

/**
 * 亮主条（DESIGN 3.4）。
 *
 * 只显示**我手里做得到**的亮法，按强度从弱到强排开 —— 不是一个下拉框，
 * 是一排按钮，每一颗上面直接写着要亮的那张牌。倒计时挂在最左边。
 */
export function DeclareBar({
  room,
  hand,
  onDeclare,
  onPass,
}: {
  room: SjPublicRoom;
  hand: SjCard[];
  onDeclare(cardIds: string[]): void;
  onPass(): void;
}) {
  const options = declareOptions(hand, room.trump, room.viewerId);
  const left = useCountdown(room.phase === 'declaring' ? room.declareEndsAt : null);
  const passed = room.passed.includes(room.viewerId);
  const declarer = room.players.find((p) => p.id === room.trump.declarerId);
  const iAmDeclarer = room.trump.declarerId === room.viewerId;

  return (
    <div className="sj-bar sj-declare">
      <span className="sj-bar-cap">
        亮主
        {room.phase === 'declaring' && (
          <>
            {' · 还剩 '}
            <b>{left}s</b>
          </>
        )}
        {room.phase === 'dealing' && ' · 发牌中'}
      </span>

      {options.map((o) => (
        <button
          key={o.key}
          className={`btn ${o.trump === 'NT' ? 'sj-nt' : 'sj-suit'} sj-declare-btn`}
          data-suit={o.trump}
          onClick={() => onDeclare(o.cardIds)}
          title={o.reinforce ? '同花色第二张级牌，把亮主抬成一对，别人再想反必须出王' : `亮${suitName(o.trump)}`}
        >
          <span className="sj-declare-glyph">{o.glyph}</span>
          <span className="sj-declare-note">{o.note}</span>
        </button>
      ))}

      {!options.length && <span className="sj-bar-note">你手里没有能亮的牌</span>}

      <button className="btn ghost" disabled={passed || iAmDeclarer} onClick={onPass}>
        {passed ? '已表态' : '不亮'}
      </button>

      <span className="sj-bar-hint">
        {declarer
          ? iAmDeclarer
            ? `你亮了 ${trumpGlyph(room.trump.suit)}，别人要反必须更强`
            : `${declarer.name} 亮了 ${trumpGlyph(room.trump.suit)}${room.trump.strength >= 2 ? '（一对）' : '（单张）'}，反主必须严格更强`
          : '无人亮主则翻底牌定主'}
      </span>
    </div>
  );
}
