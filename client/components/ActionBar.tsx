import { useEffect, useState } from 'react';
import { callCost as calcCall, canAutoStart, canCompareNow, EMOTES, type GameCommand, type PublicPlayer, type PublicRoom } from '../../shared/game.ts';
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
  const canAllIn = me.chips > 0 && me.chips <= cost;
  const canCall = me.chips > cost;

  const tiers = room.settings.betOptions.filter((x) => x > room.betUnit);
  const [tier, setTier] = useState<number | null>(tiers[0] ?? null);
  useEffect(() => {
    setTier(room.settings.betOptions.find((x) => x > room.betUnit) ?? null);
  }, [room.betUnit, room.settings.betOptions]);

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
        {me.status === 'waiting' ? (
          <strong>已入座，等待下一局</strong>
        ) : me.status === 'folded' ? (
          <strong className="dim">你已弃牌，等待本局结束</strong>
        ) : myTurn ? (
          <strong className={left <= 8 ? 'urgent' : 'hot'}>轮到你 · {left}s</strong>
        ) : (
          <strong className="dim">等待 {turnName} 行动…</strong>
        )}
        <span>
          第 {room.handNo} 局 · 第 {room.roundNo}/{room.settings.maxRounds} 轮 · 底注 {fmt(room.betUnit)}
          {compareOpen ? ' · 可比牌' : ' · 首轮中'}
        </span>
      </div>

      {me.status === 'active' && (
        <div className="bar-actions">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          <button className="btn fold" disabled={!myTurn} onClick={() => cmd({ type: 'fold' })}>
            弃牌
          </button>
          {canAllIn ? (
            <button className="btn primary allin" disabled={!myTurn} onClick={() => cmd({ type: 'all_in' })}>
              梭哈 {fmt(me.chips)}
            </button>
          ) : (
            <button className="btn primary" disabled={!myTurn || !canCall} onClick={() => cmd({ type: 'call' })}>
              跟注 {fmt(cost)}
            </button>
          )}
          <div className="raise">
            <select
              aria-label="加注档位"
              disabled={!myTurn || !tiers.length}
              value={tier ?? ''}
              onChange={(e) => setTier(Number(e.target.value))}
            >
              {tiers.map((x) => (
                <option key={x} value={x}>
                  {fmt(x)}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!myTurn || !tier || me.chips <= tier * (me.looked ? 2 : 1)}
              onClick={() => tier && cmd({ type: 'raise', unit: tier })}
            >
              加注
            </button>
          </div>
        </div>
      )}

      {myTurn && compareOpen && active.length > 1 && (
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
