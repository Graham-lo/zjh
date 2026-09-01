import type { Card } from '../../shared/game.ts';

const SUITS = { S: '♠', H: '♥', C: '♣', D: '♦' } as const;
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(rank: number) {
  return RANKS[rank] ?? String(rank);
}

/**
 * 一张牌。正反面都在 DOM 里，靠 3D 翻转切换 ——
 * 服务器把牌发过来的那一刻，翻牌动画正好盖住数据到达的瞬间。
 *
 * 牌面按真牌的排版来：左上、右下各一组角标（点数在上、花色在下，右下角旋转 180°），
 * 中间是主花色，外加一层斜向高光让纸面有光泽。牌背是金色几何暗纹加中央徽记。
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
  const rank = card ? rankLabel(card.rank) : '';
  const suit = card ? SUITS[card.suit] : '';
  const isFace = !!card && card.rank >= 11;

  return (
    <div
      key={dealKey}
      className={`pc pc-${size}${faceDown ? ' is-down' : ''}`}
      style={{ ['--i' as string]: dealIndex }}
    >
      <div className="pc-inner">
        <div className={`pc-face pc-front${isFace ? ' is-court' : ''}`} data-red={red || undefined}>
          {card ? (
            <>
              <span className="pc-idx tl">
                <b>{rank}</b>
                <i>{suit}</i>
              </span>
              <span className="pc-center">{isFace ? rank : suit}</span>
              <span className="pc-idx br">
                <b>{rank}</b>
                <i>{suit}</i>
              </span>
              <span className="pc-gloss" aria-hidden="true" />
            </>
          ) : null}
        </div>
        <div className="pc-face pc-back">
          <span className="pc-medallion">♠</span>
          <span className="pc-gloss" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
