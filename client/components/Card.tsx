import type { Card } from '../../shared/game.ts';

const SUITS = { S: '♠', H: '♥', C: '♣', D: '♦' } as const;
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(rank: number) {
  return RANKS[rank] ?? String(rank);
}

/**
 * 一张牌。正反面都在 DOM 里，靠 3D 翻转切换 ——
 * 服务器把牌发过来的那一刻，翻牌动画正好盖住数据到达的瞬间。
 */
export function PlayingCard({
  card,
  faceDown,
  size = 'mini',
  dealIndex = 0,
  dealKey,
}: {
  card?: Card;
  faceDown: boolean;
  size?: 'mini' | 'big';
  dealIndex?: number;
  dealKey?: string | number;
}) {
  const red = card ? card.suit === 'H' || card.suit === 'D' : false;
  return (
    <div
      key={dealKey}
      className={`pc pc-${size}${faceDown ? ' is-down' : ''}`}
      style={{ ['--i' as string]: dealIndex }}
    >
      <div className="pc-inner">
        <div className="pc-face pc-front" data-red={red || undefined}>
          {card ? (
            <>
              <b>{rankLabel(card.rank)}</b>
              <i>{SUITS[card.suit]}</i>
              <span className="pc-pip">{SUITS[card.suit]}</span>
            </>
          ) : null}
        </div>
        <div className="pc-face pc-back">
          <span>♠</span>
        </div>
      </div>
    </div>
  );
}
