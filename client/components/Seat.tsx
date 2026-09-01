import type { CSSProperties } from 'react';
import { evaluateHand, type Card, type PublicPlayer } from '../../shared/game.ts';
import { PlayingCard } from './Card.tsx';
import { TurnRing } from './TurnRing.tsx';

const fmt = (n: number) => n.toLocaleString('zh-CN');

export function EmptySeat({ style, onInvite, onAddBot }: {
  style: CSSProperties;
  onInvite(): void;
  onAddBot?: () => void;
}) {
  return (
    <div className="seat seat-empty" style={style}>
      <div className="empty-actions">
        <button className="btn tiny" onClick={onInvite}>
          邀请好友
        </button>
        {onAddBot && (
          <button className="btn tiny ghost" onClick={onAddBot}>
            + 电脑
          </button>
        )}
      </div>
    </div>
  );
}

function Cards({
  hand,
  revealed,
  handNo,
  big,
  onPeek,
}: {
  hand: Card[];
  revealed: boolean;
  handNo: number;
  big: boolean;
  onPeek?: () => void;
}) {
  const cards = [0, 1, 2].map((i) => (
    <PlayingCard
      key={i}
      dealKey={`${handNo}-${i}`}
      dealIndex={i}
      card={hand[i]}
      faceDown={!revealed}
      size={big ? 'big' : 'mini'}
    />
  ));
  // 自己的暗牌是个按钮：点一下就看牌，不用再去操作条里找
  if (big && !revealed && onPeek) {
    return (
      <button className="peek" onClick={onPeek}>
        {cards}
        <span className="peek-hint">点击看牌 · 之后下注翻倍</span>
      </button>
    );
  }
  return <>{cards}</>;
}

export function Seat({
  player,
  style,
  isMe,
  isHost,
  isTurn,
  deadline,
  turnSeconds,
  handNo,
  showdownHand,
  onPeek,
  celebrating,
}: {
  player: PublicPlayer;
  style: CSSProperties;
  isMe: boolean;
  isHost: boolean;
  isTurn: boolean;
  deadline: number | null;
  turnSeconds: number;
  handNo: number;
  showdownHand?: Card[];
  /** 只有自己的座位会传：点牌即看牌 */
  onPeek?: () => void;
  /** 刚赢下这一局，弹一下 */
  celebrating?: boolean;
}) {
  const hand = showdownHand ?? player.hand;
  const revealed = hand.length === 3;
  const classes = [
    'seat',
    isTurn && 'is-turn',
    celebrating && 'is-winner',
    isMe && 'is-me',
    player.status === 'folded' && 'is-folded',
    !player.online && !player.isBot && 'is-offline',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={style}>
      {player.bet > 0 && <span className="seat-bet">{fmt(player.bet)}</span>}
      <div className="seat-avatar">
        {isTurn && <TurnRing deadline={deadline} total={turnSeconds} />}
        <span className="avatar-glyph">{player.avatar}</span>
        {player.emote && (
          <span className="emote-pop" key={player.emote.at}>
            {player.emote.id}
          </span>
        )}
      </div>

      <div className="seat-body">
        <div className="seat-name">
          <b>{player.name}</b>
          {isHost && <span className="tag host">房主</span>}
          {player.isBot && <span className="tag bot">电脑</span>}
          {player.isAgent && <span className="tag agent">AI</span>}
          {!player.online && !player.isBot && <span className="tag off">离线</span>}
        </div>
        <div className="seat-chips">{fmt(player.chips)}</div>
        {player.lastAction && <div className="seat-action">{player.lastAction}</div>}
      </div>

      {/* 看过牌之后直接把牌型写出来，省得自己在心里对一遍 */}
      {revealed && <span className="hand-type seat-type">{evaluateHand(hand).name}</span>}

      <div className="seat-hand">
        {player.status === 'waiting' ? (
          <span className="hand-note">等待下局</span>
        ) : player.status === 'folded' && !revealed ? (
          <span className="hand-note folded">已弃牌</span>
        ) : player.hasHand || revealed ? (
          <Cards hand={hand} revealed={revealed} handNo={handNo} big={isMe} onPeek={onPeek} />
        ) : null}
      </div>
    </div>
  );
}
