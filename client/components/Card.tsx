import type { Card } from '../../shared/game.ts';

const SUITS = { S: '♠', H: '♥', C: '♣', D: '♦' } as const;
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(rank: number) {
  return RANKS[rank] ?? String(rank);
}

/** 牌面的三种成色，用来在同一个组件里表达胜/负两种结局 */
export type CardTone = 'win' | 'fold' | 'shard';

/**
 * 牌型的稀有度分档。徽章按档位从「实金」一路退到「描边」——
 * 稀有度是这个游戏里唯一值得炫耀的东西，配色得跟着它走。
 */
export function handRarity(name: string): 'top' | 'high' | 'mid' | 'low' {
  if (name === '豹子') return 'top';
  if (name === '顺金') return 'high';
  if (name === '金花') return 'mid';
  return 'low';
}

/**
 * 一张牌。正反面都在 DOM 里，靠 3D 翻转切换 ——
 * 服务器把牌发过来的那一刻，翻牌动画正好盖住数据到达的瞬间。
 *
 * 排版照真牌来：角标「点数在上、花色在下」，右下角整组旋转 180°；
 * 4px 内框收住版心；118° 斜向高光让纸面有光泽而不是一块平色。
 * 主图按点数分三种：数字牌是大花色，JQK 是字母外套双环纹章，
 * A 单独给一圈金晕 —— 牌桌上最大的那张牌值得被一眼认出来。
 *
 * DOM 分了三层且各管一件事，否则动画会互相抢 transform：
 *   .pc      发牌（弧线甩出 + 落点回弹）
 *   .pc-lift 翻牌中段的抬起、发完牌后的呼吸提示
 *   .pc-inner 3D 翻面本身
 */
export function PlayingCard({
  card,
  faceDown,
  size = 'mini',
  dealIndex = 0,
  dealKey,
  tone,
}: {
  card?: Card;
  faceDown: boolean;
  size?: 'mini' | 'big';
  dealIndex?: number;
  dealKey?: string | number;
  /** 结局态：胜者金边辉光、败者去饱和、比牌败者碎裂坠落 */
  tone?: CardTone;
}) {
  const red = card ? card.suit === 'H' || card.suit === 'D' : false;
  const rank = card ? rankLabel(card.rank) : '';
  const suit = card ? SUITS[card.suit] : '';
  const isCourt = !!card && card.rank >= 11 && card.rank <= 13;
  const isAce = card?.rank === 14;

  const cls = [
    'pc',
    `pc-${size}`,
    faceDown && 'is-down',
    tone === 'win' && 'is-won',
    tone === 'fold' && 'is-dead',
    tone === 'shard' && 'is-shard',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div key={dealKey} className={cls} style={{ ['--i' as string]: dealIndex }}>
      <div className="pc-lift">
        <div className="pc-inner">
          <div
            className={`pc-face pc-front${isCourt ? ' is-court' : ''}${isAce ? ' is-ace' : ''}`}
            data-red={red || undefined}
          >
            {card ? (
              <>
                <span className="pc-idx tl">
                  <b>{rank}</b>
                  <i>{suit}</i>
                </span>
                {isCourt ? (
                  <span className="pc-center">
                    <span className="pc-crest">
                      <b>{rank}</b>
                    </span>
                    <i className="pc-crest-suit">{suit}</i>
                  </span>
                ) : (
                  <span className="pc-center">
                    <i className="pc-pip">{suit}</i>
                  </span>
                )}
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
    </div>
  );
}
