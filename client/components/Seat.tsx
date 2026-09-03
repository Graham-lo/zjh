import type { CSSProperties } from 'react';
import { evaluateHand, type Card, type PublicPlayer } from '../../shared/game.ts';
import { handRarity, PlayingCard, type CardTone } from './Card.tsx';
import { IconEye, Laurel } from './Icons.tsx';
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
  tone,
  onPeek,
}: {
  hand: Card[];
  revealed: boolean;
  handNo: number;
  big: boolean;
  tone?: CardTone;
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
      tone={tone}
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
  playing,
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
  /** 本局是否进行中。「已看牌」只在牌局里才有意义，大厅和结算后不显示 */
  playing: boolean;
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
  const folded = player.status === 'folded';
  const classes = [
    'seat',
    isTurn && 'is-turn',
    celebrating && 'is-winner',
    isMe && 'is-me',
    folded && 'is-folded',
    !player.online && !player.isBot && 'is-offline',
  ]
    .filter(Boolean)
    .join(' ');
  const type = revealed ? evaluateHand(hand).name : null;
  // 只标看过牌的人，闷牌的什么都不挂：全场都挂徽章等于没有信息，
  // 用「有没有这个标」表达状态，扫一眼就知道谁看过牌。
  // 手里真有牌才标 —— 等下局、已弃牌、大厅阶段挂着它只是占位置。
  const showLooked = playing && player.looked && player.status === 'active' && (player.hasHand || revealed);

  return (
    <div className={classes} style={style}>
      {celebrating && <Laurel id={`laurel-${player.id}`} />}
      {player.bet > 0 && <span className="seat-bet">{fmt(player.bet)}</span>}
      {/* 挂在座位左上角，和右上角的投注额凑成一对，而不是挤进名字那一行 ——
          名字行只有 96px，再塞一个徽章会把「房主 + 已看牌」的人名挤成省略号 */}
      {showLooked && (
        <span className="tag looked" title="已经看过牌，之后下注翻倍">
          <IconEye size={11} />
          <i>已看牌</i>
        </span>
      )}
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
          {player.isBot && (
            <span className="tag bot" title="基础风格；机器人会根据临场局面切换打法">
              电脑{player.botStyle ? `·${player.botStyle}` : ''}
            </span>
          )}
          {player.isAgent && <span className="tag agent">AI</span>}
          {!player.online && !player.isBot && <span className="tag off">离线</span>}
        </div>
        <div className="seat-chips">{fmt(player.chips)}</div>
        {player.lastAction && <div className="seat-action">{player.lastAction}</div>}
      </div>

      {/* 看过牌之后直接把牌型写出来，省得自己在心里对一遍。
          金花及以上多一圈金色波纹 —— 好牌值得被看见。 */}
      {type && (
        <span className={`hand-type seat-type r-${handRarity(type)}`} key={`${handNo}-${type}`}>
          {type}
        </span>
      )}

      <div className="seat-hand">
        {player.status === 'waiting' ? (
          <span className="hand-note">等待下局</span>
        ) : folded && !revealed ? (
          <span className="hand-note folded">已弃牌</span>
        ) : player.hasHand || revealed ? (
          <Cards
            hand={hand}
            revealed={revealed}
            handNo={handNo}
            big={isMe}
            tone={celebrating ? 'win' : folded ? 'fold' : undefined}
            onPeek={onPeek}
          />
        ) : null}
      </div>
    </div>
  );
}
