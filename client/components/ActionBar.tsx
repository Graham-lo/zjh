import { useEffect, useRef, useState } from 'react';
import {
  allInBase as calcAllInBase, allInCost as calcAllIn, callCost as calcCall, canAllInNow, canAutoStart, canCompareNow,
  EMOTES, evaluateHand, type GameCommand, type PublicPlayer, type PublicRoom,
} from '../../shared/game.ts';
import { handRarity } from './Card.tsx';
import { useCountdown } from './TurnRing.tsx';

const fmt = (n: number) => n.toLocaleString('zh-CN');

export function ActionBar({
  room,
  me,
  cmd,
  onInvite,
  onInviteCli,
}: {
  room: PublicRoom;
  me: PublicPlayer;
  cmd(c: GameCommand): void;
  onInvite(): void;
  onInviteCli(): void;
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
  // 梭哈也走「闷牌一份、看牌两份」：这里是**我**发起要掏的数。
  // 单价上限由场上最短的一家决定（按各自倍率折算），所以人人都掏得起自己那份。
  const shovePrice = calcAllIn(room, me);
  const shoveOpen = canAllInNow(room);
  const shoveForced = me.chips <= cost; // 跟不起时随时可以梭哈脱身
  const canShove = me.chips > 0 && active.length > 1 && (shoveOpen || shoveForced);
  const handType = me.looked && me.hand.length === 3 ? evaluateHand(me.hand).name : null;
  const shoveBase = calcAllInBase(room);
  const shove = room.allIn;
  /**
   * 表态阶段我自己要掏的数。看牌是自由动作、不占行动权，所以在这里点一下看牌，
   * 倍率立刻从 1 跳到 2，这个数也就当场翻倍 —— 翻过身家就夹到全部筹码，
   * 和服务端 doCall 的算法逐字一致，不会出现「按钮显示能接、点了说钱不够」。
   */
  const acceptPrice = shove ? Math.min(shove.base * (me.looked ? 2 : 1), me.chips) : 0;
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
              <button className="btn" title="复制一条命令，朋友粘到终端就能进这个房间" onClick={onInviteCli}>
                命令行加入
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
  // 最后 8 秒行动台边缘跟着心跳脉动，和头像上的倒计时环是同一套节律
  const urgent = myTurn && left > 0 && left <= 8;

  return (
    <div className={`bar${urgent ? ' is-urgent' : ''}${shove ? ' is-shove' : ''}`}>
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
          {handType && <b className={`hand-type r-${handRarity(handType)}`} title="你的牌型">{handType}</b>}
          第 {room.handNo} 局 · 第 {room.roundNo}/{room.settings.maxRounds} 轮 · 底注 {fmt(room.betUnit)}
          {compareOpen ? ' · 可比牌' : ' · 首轮中'}
          {/* 梭哈还没开放时把门槛写出来，省得有人一直找那个按钮 */}
          {!shoveOpen && ` · 第 ${allInFrom} 轮起可梭哈`}
        </span>
      </div>

      {me.status === 'active' && shove && (
        <div className="bar-actions shove-choice">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          {/* 有人梭哈时只有两条路：接，或者弃。
              按钮上写的是**我自己**要掏的数，和播报里发起人的金额本来就可以不一样 ——
              闷牌半价、看牌双倍。上面那个「看牌」按下去，这个数会当场变成两倍。 */}
          <button
            className="btn primary accept"
            disabled={!myTurn || acceptPrice <= 0}
            title={
              me.looked
                ? `看过牌，接梭哈是双倍：${fmt(acceptPrice)}`
                : `闷牌半价：${fmt(acceptPrice)}；现在看牌的话这一份会变成 ${fmt(Math.min(shove.base * 2, me.chips))}`
            }
            onClick={() => cmd({ type: 'call' })}
          >
            接受梭哈 {fmt(acceptPrice)}
            {!me.looked && <small className="hint-half"> 闷牌半价</small>}
          </button>
          <button className="btn fold" disabled={!myTurn} onClick={() => cmd({ type: 'fold' })}>
            弃牌
          </button>
        </div>
      )}

      {/* 主行动排：弃牌 / 跟注 / 加注档 / 梭哈 一次排开，点一下就走 ——
          下拉框要点两次还挡住牌桌。手机上靠 flex-wrap 自然折成两行，
          第一行是最常用的三个大目标，加注档退到第二行。 */}
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
          <button className="btn primary call" disabled={!myTurn || !canCall} onClick={() => cmd({ type: 'call' })}>
            跟注 {fmt(cost)}
          </button>
          {tiers.map((x) => (
            <button
              key={x}
              className="btn tier"
              disabled={!myTurn || me.chips <= x * (me.looked ? 2 : 1)}
              title={`本次需要投入 ${fmt(x * (me.looked ? 2 : 1))}`}
              onClick={() => cmd({ type: 'raise', unit: x })}
            >
              加注 {fmt(x)}
            </button>
          ))}
          {/* 条件不满足时干脆不显示，而不是摆一个点不动的按钮 */}
          {canShove && (
            <button
              className="btn allin"
              disabled={!myTurn}
              title={
                `你先出 ${fmt(shovePrice)}：闷牌一份 ${fmt(shoveBase)}、看牌两份 ${fmt(shoveBase * 2)}` +
                `，单价上限由场上最短的一家决定。其他人按各自的倍率选接或弃`
              }
              onClick={() => cmd({ type: 'all_in' })}
            >
              梭哈 {fmt(shovePrice)}
            </button>
          )}
        </div>
      )}

      {/* 比牌行：谁能被比一目了然，自动跟注靠右单独站着不抢戏 */}
      {me.status === 'active' && !shove && (
        <div className="compare-row">
          {myTurn && compareOpen && active.length > 1 ? (
            <>
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
            </>
          ) : (
            <span>{compareOpen ? `比牌 ${fmt(comparePrice)} · 轮到你时可选对手` : '首轮走完后开放比牌'}</span>
          )}
          <button
            className={`btn tiny auto${autoCall ? ' on' : ''}`}
            title="自动跟注；跟不起时自动梭哈。有人梭哈会自动交还给你决定"
            onClick={() => setAutoCall((v) => !v)}
          >
            {autoCall ? '● 自动跟注中' : '自动跟注'}
          </button>
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
