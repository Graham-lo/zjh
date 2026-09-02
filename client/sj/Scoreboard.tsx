import { useState } from 'react';
import { levelLabel, type SjCard } from '../../shared/sj/cards.ts';
import type { SjPublicRoom } from '../../shared/sj/engine.ts';
import { PlayingCard } from '../components/Card.tsx';
import { useCountUp } from './useCountUp.ts';
import { teamOfSeat, trumpGlyph, trumpText } from './util.ts';

/** 闲家上台线 80 分、满分 200 分（DESIGN 1.8），环上那道金刻度就落在 80 那一格 */
const FULL = 200;
const UP = 80;
const TICK = (UP / FULL) * 360;

/**
 * 闲家得分环。conic-gradient 画进度，外面再叠一圈只有 2° 宽的金线当 80 分刻度 ——
 * 一眼就能看出「离上台还有多远」，而不是去读一个数字。
 */
function ScoreRing({ points }: { points: number }) {
  const shown = useCountUp(points);
  const deg = Math.min(360, (Math.max(0, shown) / FULL) * 360);
  return (
    <div
      className={`sj-ring${shown >= UP ? ' is-up' : ''}`}
      style={{ ['--deg' as string]: `${deg}deg`, ['--tick' as string]: `${TICK}deg` }}
    >
      <span className="sj-ring-tick" aria-hidden="true" />
      <b className="sj-ring-num">{shown}</b>
    </div>
  );
}

/** 两队的级别徽章。升级那一下要看得见，所以级别一变就 3D 翻面 */
function LevelBadge({ level, mine, dealer }: { level: number; mine: boolean; dealer: boolean }) {
  return (
    <div className={`sj-level${mine ? ' mine' : ''}`}>
      <span>{mine ? '我方' : '对方'}{dealer ? ' · 庄' : ''}</span>
      <b key={level} className="sj-level-num">
        {levelLabel(level)}
      </b>
    </div>
  );
}

function CardStrip({ cards, faceDown, count }: { cards: SjCard[]; faceDown?: boolean; count?: number }) {
  const n = count ?? cards.length;
  return (
    <div className="sj-strip">
      {Array.from({ length: n }, (_, i) => (
        <span key={cards[i]?.id ?? i} className="sj-strip-card" style={{ ['--i' as string]: i }}>
          <PlayingCard card={faceDown ? undefined : cards[i]} faceDown={!!faceDown || !cards[i]} size="tiny" />
        </span>
      ))}
    </div>
  );
}

/**
 * 左栏记分板（DESIGN 3.3）：两队级别与庄家标记、主花色大徽章、
 * 闲家得分环、分牌堆（可展开）、底牌 8 张、圈数与已出张数。
 */
export function Scoreboard({ room, mySeat, myHand }: { room: SjPublicRoom; mySeat: number; myHand: number }) {
  const [openPile, setOpenPile] = useState(false);
  const myTeam = teamOfSeat(mySeat);
  const dealerTeam = teamOfSeat(room.dealerSeat);
  // 「已出 m/25 张」是每家各自出了多少 —— 一圈四家张数相同，所以看自己的就够
  const played = Math.max(0, 25 - myHand);
  const phaseNote =
    room.phase === 'dealing' ? '发牌中'
      : room.phase === 'declaring' ? '亮主中'
        : room.phase === 'kou' ? '扣底中'
          : room.phase === 'lobby' ? '等待开局'
            : `第 ${room.trickNo} 圈 · 已出 ${played}/25 张`;

  const pile = room.capturedPointCards;
  const bottomShown = room.bottom.length > 0;

  return (
    <div className="sj-board">
      <section className="sj-panel">
        <div className="hairline top" aria-hidden="true" />
        <div className="sj-panel-cap">级 别</div>
        <div className="sj-levels">
          <LevelBadge level={room.levels[myTeam]} mine dealer={dealerTeam === myTeam} />
          <LevelBadge level={room.levels[1 - myTeam]} mine={false} dealer={dealerTeam !== myTeam} />
        </div>
        <div className="sj-trump">
          <span className="sj-trump-badge" aria-hidden="true">
            {trumpGlyph(room.trump.suit)}
          </span>
          <div>
            <div className="sj-panel-cap">主 牌</div>
            <div className="sj-trump-text">{trumpText(room.trump.suit, room.trump.level)}</div>
          </div>
        </div>
      </section>

      <section className="sj-panel">
        <div className="hairline top" aria-hidden="true" />
        <div className="sj-panel-head">
          <span className="sj-panel-cap">闲 家 得 分</span>
          <span className="sj-panel-sub">{phaseNote}</span>
        </div>
        <div className="sj-score">
          <ScoreRing points={room.defenderPoints} />
          <div className="sj-score-legend">
            <span>
              <b>{UP}</b> 上台
            </span>
            <span>
              <b className="dim">{FULL}</b> 满分
            </span>
            <span className="dim">40 分一级</span>
          </div>
        </div>
        <button
          className={`sj-pile${openPile ? ' open' : ''}`}
          onClick={() => setOpenPile((v) => !v)}
          aria-expanded={openPile}
        >
          <CardStrip cards={openPile ? pile : pile.slice(-6)} />
          <span className="sj-pile-note">
            {pile.length ? `分牌堆 ${pile.length} 张 · 点开${openPile ? '收起' : '看'}` : '还没抓到分牌'}
          </span>
        </button>
      </section>

      <section className="sj-panel sj-bottom">
        <div className="hairline top" aria-hidden="true" />
        <div>
          <div className="sj-panel-cap">底 牌</div>
          <div className="sj-panel-sub">
            {room.bottomRevealed ? '本局已翻开' : room.phase === 'kou' ? '庄家扣底中' : `${room.bottomCount || 8} 张 · 庄家已扣`}
          </div>
        </div>
        <CardStrip cards={room.bottom} faceDown={!bottomShown} count={Math.max(room.bottomCount, bottomShown ? room.bottom.length : 8)} />
      </section>
    </div>
  );
}

/** 手机上的记分板：压成顶栏一行（DESIGN 3.3） */
export function MiniBoard({ room, mySeat }: { room: SjPublicRoom; mySeat: number }) {
  const myTeam = teamOfSeat(mySeat);
  const points = useCountUp(room.defenderPoints);
  return (
    <div className="sj-mini">
      <div className="sj-mini-lv">
        <b>{levelLabel(room.levels[myTeam])}</b>
        <span>vs</span>
        <i>{levelLabel(room.levels[1 - myTeam])}</i>
      </div>
      <div className="sj-mini-trump">
        <b>{trumpGlyph(room.trump.suit)}</b> 主 · 打 {levelLabel(room.trump.level)}
      </div>
      <div className="sj-mini-score">
        闲家 <b>{points}</b>/80
      </div>
    </div>
  );
}
