import { useEffect, useRef, useState } from 'react';
import {
  allInCost as calcAllIn, callCost as calcCall, canAllInNow, canAutoStart, canCompareNow,
  EMOTES, evaluateHand, type GameCommand, type PublicPlayer, type PublicRoom,
} from '../../shared/game.ts';
import { useCountdown } from './TurnRing.tsx';

const fmt = (n: number) => n.toLocaleString('zh-CN');

export function ActionBar({
  room,
  me,
  cmd,
  onInvite,
}: {
  room: PublicRoom;
  me: PublicPlayer;
  cmd(c: GameCommand): void;
  onInvite(): void;
}) {
  const isHost = room.hostId === me.id;
  const myTurn = room.phase === 'playing' && room.turnSeat === me.seat && me.status === 'active';
  const left = useCountdown(myTurn ? room.turnDeadline : null);

  // 这些数字和服务端用的是同一份函数，不会出现"按钮显示能跟、点了说钱不够"
  const cost = calcCall(room, me);
  const comparePrice = cost * 2;
  const active = room.players.filter((p) => p.status === 'active');
  const compareOpen = canCompareNow(room);
  const canCall = me.chips > cost;
  // 梭哈金额由场上最短的一家决定，所有人都跟得起
  const shovePrice = calcAllIn(room);
  const shoveOpen = canAllInNow(room);
  const shoveForced = me.chips <= cost; // 跟不起时随时可以梭哈脱身
  const canShove = me.chips > 0 && active.length > 1 && (shoveOpen || shoveForced);
  const handType = me.looked && me.hand.length === 3 ? evaluateHand(me.hand).name : null;
  const shove = room.allIn;
  // 兜底：万一房间是老快照，别把 undefined 显示出来
  const allInFrom = room.settings.allInFromRound ?? 3;

  const tiers = room.settings.betOptions.filter((x) => x > room.betUnit);
  /**
   * 自动跟注（挂机）。跟不起时自动改成梭哈，正好是「钱没了自动梭哈比牌」。
   * 有人梭哈时会自动关掉交还给人 —— 接不接一个全场开牌的注，不该由一个勾选框替你决定。
   */
  const [autoCall, setAutoCall] = useState(false);
  const firedRef = useRef('');
  useEffect(() => {
    if (!autoCall) return;
    if (shove) {
      setAutoCall(false);
      return;
    }
    if (!myTurn || me.status !== 'active') return;
    const token = `${room.handNo}:${room.turnCount}`;
    if (firedRef.current === token) return;
    firedRef.current = token;
    const t = setTimeout(() => {
      if (me.chips > cost) cmd({ type: 'call' });
      else if (me.chips > 0) cmd({ type: 'all_in' });
      else cmd({ type: 'fold' });
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCall, myTurn, !!shove, room.handNo, room.turnCount]);

  // 非自己回合弃牌要点两次 —— 用原生 confirm 会打断节奏，手机上尤其难受
  const [armFold, setArmFold] = useState(false);
  useEffect(() => {
    if (!armFold) return;
    const t = setTimeout(() => setArmFold(false), 3000);
    return () => clearTimeout(t);
  }, [armFold]);
  useEffect(() => setArmFold(false), [room.handNo, myTurn]);

  if (room.phase === 'lobby') {
    const seated = room.players.length;
    const readyCount = room.players.filter((p) => p.isBot || p.ready).length;
    return (
      <div className="bar">
        <div className="bar-status">
          <strong>
            {seated}/{room.settings.maxPlayers} 人
          </strong>
          <span>
            已准备 {readyCount} · 底注 {fmt(room.settings.ante)} · {room.settings.maxRounds} 轮封顶
          </span>
        </div>
        <div className="bar-actions">
          <button className={`btn ${me.ready ? 'ghost' : 'primary'}`} onClick={() => cmd({ type: 'ready', ready: !me.ready })}>
            {me.ready ? '取消准备' : '准备'}
          </button>
          {me.chips < room.settings.ante * 2 && (
            <button className="btn" onClick={() => cmd({ type: 'top_up' })}>
              补充积分
            </button>
          )}
          {seated < room.settings.maxPlayers && (
            <>
              <button className="btn" onClick={onInvite}>
                邀请好友
              </button>
              {isHost && (
                <button className="btn" onClick={() => cmd({ type: 'add_bot' })}>
                  + 电脑玩家
                </button>
              )}
            </>
          )}
          {isHost && (
            <button
              className="btn primary go"
              disabled={readyCount < 2}
              onClick={() => cmd({ type: 'start' })}
            >
              开始这一局
            </button>
          )}
        </div>
        {canAutoStart(room) && <p className="bar-hint">所有人都准备好了，马上自动开局</p>}
      </div>
    );
  }

  if (room.phase !== 'playing') return null;

  const turnName = room.players.find((p) => p.seat === room.turnSeat)?.name ?? '玩家';

  return (
    <div className="bar">
      <div className="bar-status">
        {shove ? (
          me.status !== 'active' ? (
            <strong className="dim">{shove.initiatorName} 梭哈了 {fmt(shove.amount)}</strong>
          ) : myTurn ? (
            <strong className="shove-call">
              {shove.initiatorName} 梭哈 {fmt(shove.amount)} · 接还是弃？{left}s
            </strong>
          ) : (
            <strong className="dim">
              {shove.initiatorName} 梭哈了 {fmt(shove.amount)}，等 {room.players.find((p) => p.seat === room.turnSeat)?.name ?? '玩家'} 表态…
            </strong>
          )
        ) : me.status === 'waiting' ? (
          <strong>已入座，等待下一局</strong>
        ) : me.status === 'folded' ? (
          <strong className="dim">你已弃牌，等待本局结束</strong>
        ) : myTurn ? (
          <strong className={left <= 8 ? 'urgent' : 'hot'}>轮到你 · {left}s</strong>
        ) : (
          <strong className="dim">等待 {turnName} 行动…</strong>
        )}
        <span className="bar-meta">
          {handType && <b className="hand-type" title="你的牌型">{handType}</b>}
          第 {room.handNo} 局 · 第 {room.roundNo}/{room.settings.maxRounds} 轮 · 底注 {fmt(room.betUnit)}
          {compareOpen ? ' · 可比牌' : ' · 首轮中'}
        </span>
      </div>

      {me.status === 'active' && shove && (
        <div className="bar-actions shove-choice">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          {/* 有人梭哈时只有两条路：接，或者弃 */}
          <button
            className="btn primary accept"
            disabled={!myTurn || me.chips < shove.amount}
            onClick={() => cmd({ type: 'call' })}
          >
            接受梭哈 {fmt(shove.amount)}
          </button>
          <button className="btn fold" disabled={!myTurn} onClick={() => cmd({ type: 'fold' })}>
            弃牌
          </button>
        </div>
      )}

      {me.status === 'active' && !shove && (
        <div className="bar-actions">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          {/* 弃牌和看牌一样不占行动权：牌烂就直接走，不用干等别人慢慢想 */}
          <button
            className={`btn fold${armFold ? ' armed' : ''}`}
            onClick={() => {
              if (myTurn) return cmd({ type: 'fold' });
              if (!armFold) return setArmFold(true);
              setArmFold(false);
              cmd({ type: 'fold' });
            }}
          >
            {armFold ? '再点一次确认' : '弃牌'}
          </button>
          <button className="btn primary" disabled={!myTurn || !canCall} onClick={() => cmd({ type: 'call' })}>
            跟注 {fmt(cost)}
          </button>
          {/* 条件不满足时干脆不显示，而不是摆一个点不动的按钮 */}
          {canShove && (
            <button
              className="btn allin"
              disabled={!myTurn}
              title={`你先出 ${fmt(shovePrice)}（场上最少的一家），其他人自己选接或弃`}
              onClick={() => cmd({ type: 'all_in' })}
            >
              梭哈 {fmt(shovePrice)}
            </button>
          )}
        </div>
      )}

      {/* 加注档位平铺成一排，点一下就走 —— 下拉框要点两次还挡住牌桌 */}
      {me.status === 'active' && !shove && (
        <div className="raise-row">
          {tiers.length > 0 && <span>加注到</span>}
          {tiers.map((x) => (
            <button
              key={x}
              className="btn tier"
              disabled={!myTurn || me.chips <= x * (me.looked ? 2 : 1)}
              title={`本次需要投入 ${fmt(x * (me.looked ? 2 : 1))}`}
              onClick={() => cmd({ type: 'raise', unit: x })}
            >
              {fmt(x)}
            </button>
          ))}
          <button
            className={`btn auto${autoCall ? ' on' : ''}`}
            title="自动跟注；跟不起时自动梭哈。有人梭哈会自动交还给你决定"
            onClick={() => setAutoCall((v) => !v)}
          >
            {autoCall ? '● 自动跟注中' : '自动跟注'}
          </button>
        </div>
      )}

      {myTurn && !shove && compareOpen && active.length > 1 && (
        <div className="compare-row">
          <span>比牌 {fmt(comparePrice)}：</span>
          {active
            .filter((p) => p.id !== me.id)
            .map((p) => (
              <button
                key={p.id}
                className="btn tiny"
                disabled={me.chips < comparePrice}
                onClick={() => cmd({ type: 'compare', targetId: p.id })}
              >
                {p.avatar} {p.name}
              </button>
            ))}
        </div>
      )}

      {isHost && room.players.some((p) => !p.isBot && !p.online && p.status === 'active') && (
        <div className="compare-row rescue">
          <span>有人掉线卡住牌桌：</span>
          {room.players
            .filter((p) => !p.isBot && !p.online && p.status === 'active')
            .map((p) => (
              <button key={p.id} className="btn tiny danger" onClick={() => cmd({ type: 'remove_player', targetId: p.id })}>
                代 {p.name} 弃牌
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function EmoteBar({ cmd }: { cmd(c: GameCommand): void }) {
  return (
    <div className="emote-bar">
      {EMOTES.map((e) => (
        <button key={e} className="emote-btn" onClick={() => cmd({ type: 'emote', id: e })} aria-label={`发送表情 ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}
