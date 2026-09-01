import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateHand, type GameCommand, type PublicPlayer, type PublicRoom } from '../shared/game.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { ActionBar, EmoteBar } from './components/ActionBar.tsx';
import { PlayingCard } from './components/Card.tsx';
import { Dock } from './components/Dock.tsx';
import { EmptySeat, Seat } from './components/Seat.tsx';
import type { NetStatus } from './net.ts';
import { HAND_VOICE, sound, voice } from './sound.ts';

const fmt = (n: number) => n.toLocaleString('zh-CN');

/** 底池数字滚动，让"钱变多了"这件事看得见 */
function useCountUp(target: number, ms = 480) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - (1 - k) ** 3;
      const v = Math.round(from + (target - from) * eased);
      current.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // 标签页在后台时 requestAnimationFrame 不会触发，
    // 用一个定时器兜底，保证数字最终一定落到正确值上。
    const settle = setTimeout(() => {
      current.current = target;
      setValue(target);
    }, ms + 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [target, ms]);
  return value;
}

interface FlyChip {
  id: number;
  left: string;
  top: string;
  amount: number;
}

/**
 * 座位沿椭圆均分：3 个人就是等边三角形，6 个人才是六等分。
 * 固定 6 个槽位在人少的时候会让半张桌子空着，看着像掉线了。
 * k = 0 永远是"我"，落在最下方。
 */
function seatPos(k: number, total: number) {
  const angle = Math.PI / 2 + (k * 2 * Math.PI) / Math.max(1, total);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // 半径交给 CSS 变量，手机上收紧一点，座位就不会被挤出屏幕。
  // --deal-x/y 是从桌心指向这个座位的反向量，发牌动画用它让牌从中间飞出来。
  return {
    left: `calc(50% + var(--seat-rx) * ${cos.toFixed(4)})`,
    top: `calc(50% + var(--seat-ry) * ${sin.toFixed(4)})`,
    ['--deal-x' as string]: `${(-cos * 260).toFixed(0)}px`,
    ['--deal-y' as string]: `${(-sin * 150).toFixed(0)}px`,
  };
}

export function Table({
  room,
  cmd,
  status,
  latency,
  batch,
  onToast,
}: {
  room: PublicRoom;
  cmd(c: GameCommand): void;
  status: NetStatus;
  latency: number;
  batch: { seq: number; events: GameEvent[] };
  onToast(msg: string): void;
}) {
  const me = room.players.find((p) => p.id === room.viewerId);
  const [dockOpen, setDockOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [chips, setChips] = useState<FlyChip[]>([]);
  const [flash, setFlash] = useState<'win' | 'lose' | null>(null);
  const [fx, setFx] = useState<{ id: number; label: string; kind: string } | null>(null);
  const fxId = useRef(0);
  const [muted, setMuted] = useState(!sound.enabled);
  const [mutedVoice, setMutedVoice] = useState(!voice.enabled);
  const seen = useRef(0);
  const chipId = useRef(0);

  const M = room.settings.maxPlayers;
  const mySeat = me?.seat ?? 0;

  // 按"从我开始顺时针"排好座，再沿椭圆均分
  const seated = useMemo(() => {
    const ordered = [...room.players].sort(
      (a, b) => ((a.seat - mySeat + M) % M) - ((b.seat - mySeat + M) % M),
    );
    const showInvite = room.phase === 'lobby' && ordered.length < M;
    const total = ordered.length + (showInvite ? 1 : 0);
    return {
      showInvite,
      total,
      slots: ordered.map((p, k) => ({ player: p, ...seatPos(k, total) })),
      invitePos: seatPos(ordered.length, total),
      posById: new Map(ordered.map((p, k) => [p.id, seatPos(k, total)])),
    };
  }, [room.players, room.phase, mySeat, M]);
  const pot = useCountUp(room.phase === 'round_end' ? (room.result?.potWon ?? 0) : room.pot);

  /* 事件 → 音效与动画。状态永远以 room 为准，事件只负责"表演"。 */
  useEffect(() => {
    if (batch.seq === seen.current) return;
    seen.current = batch.seq;
    for (const ev of batch.events) {
      switch (ev.k) {
        case 'deal': {
          ev.seats.forEach((_, i) => sound.play('deal', i));
          break;
        }
        case 'bet': {
          const from = seated.posById.get(ev.playerId);
          if (from) {
            const id = ++chipId.current;
            setChips((c) => [...c, { id, ...from, amount: ev.amount }]);
            setTimeout(() => setChips((c) => c.filter((x) => x.id !== id)), 900);
          }
          sound.play('chip');
          voice.play(ev.kind === 'all_in' ? 'allin' : ev.kind);
          if (ev.kind === 'all_in') {
            burst('allin', '梭 哈');
            navigator.vibrate?.([30, 60, 30, 60, 30]);
          } else if (ev.kind === 'accept') {
            burst('accept', '接');
            navigator.vibrate?.([20, 40, 20]);
          } else if (ev.kind === 'compare') {
            burst('compare', '比 牌');
          }
          break;
        }
        case 'look':
          if (ev.playerId === room.viewerId) sound.play('flip');
          break;
        case 'fold':
          voice.play('fold');
          break;
        case 'turn':
          if (ev.playerId === room.viewerId) {
            sound.play('turn');
            voice.play('turn');
            navigator.vibrate?.(30);
          }
          break;
        case 'showdown': {
          burst('showdown', '开 牌');
          // 开牌这一下是全场最有戏的时刻，直接把赢家的牌型念出来
          const hand = room.result?.hands[ev.winnerId];
          if (hand?.length === 3) voice.play(HAND_VOICE[evaluateHand(hand).name] ?? 'sanpai');
          break;
        }
        case 'win': {
          const mine = ev.playerId === room.viewerId;
          const played = me && me.bet > 0;
          if (mine) {
            sound.play('win');
            setFlash('win');
          } else if (played) {
            sound.play('lose');
            setFlash('lose');
          }
          setTimeout(() => setFlash(null), 1400);
          break;
        }
        case 'chat':
          if (!dockOpen) setUnread((u) => u + 1);
          sound.play('msg');
          break;
        default:
          break;
      }
    }
  }, [batch.seq]);

  useEffect(() => {
    if (dockOpen) setUnread(0);
  }, [dockOpen]);

  /** 中央砸下一个大字 + 全屏闪光，牌桌上最有戏的几下都走这里 */
  function burst(kind: string, label: string) {
    const id = ++fxId.current;
    setFx({ id, label, kind });
    setTimeout(() => setFx((f) => (f?.id === id ? null : f)), 1100);
  }

  if (!me) return <div className="loading">正在回到牌桌…</div>;

  const copy = (text: string, okMsg: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => onToast(okMsg))
      .catch(() => onToast(`房间号 ${room.code}`));
  };
  const invite = () => copy(`${location.origin}/?room=${room.code}`, '邀请链接已复制，发给好友即可');
  // 命令行客户端由服务器本身分发，朋友不用 clone 仓库
  const inviteCli = () =>
    copy(
      `curl -fsSL ${location.origin}/cli.mjs -o zjh.mjs && node zjh.mjs "${location.origin}/?room=${room.code}"`,
      '命令行加入命令已复制（需要对方装了 Node 22+）',
    );

  const result = room.result;
  const showdownHands = result?.hands ?? {};

  return (
    <main className={`table-shell${flash ? ` flash-${flash}` : ''}${fx?.kind === 'allin' ? ' shake' : ''}`}>
      <header className="topbar">
        <div className="topbar-left">
          <b>好友炸金花</b>
          <button className="room-pill" onClick={invite} title="点击复制邀请链接">
            房间 {room.code} <span>复制</span>
          </button>
        </div>
        <div className="topbar-right">
          <span className={`net-pill net-${status}`} title={`延迟 ${latency}ms`}>
            <i />
            {status === 'online' ? `${latency}ms` : status === 'connecting' ? '连接中' : '重连中'}
          </span>
          <button
            className="icon-btn"
            aria-label={muted ? '开启音效' : '关闭音效'}
            title={muted ? '音效已关闭' : '音效已开启'}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              sound.setEnabled(!next);
            }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          {voice.available && (
            <button
              className={`icon-btn${mutedVoice ? ' off' : ''}`}
              aria-label={mutedVoice ? '开启语音播报' : '关闭语音播报'}
              title={mutedVoice ? '语音播报已关闭' : '语音播报已开启'}
              onClick={() => {
                const next = !mutedVoice;
                setMutedVoice(next);
                voice.unlock();
                voice.setEnabled(!next);
              }}
            >
              🗣️
            </button>
          )}
          <button
            className="icon-btn danger"
            onClick={() => window.confirm('确定退出房间？') && cmd({ type: 'leave' })}
            aria-label="退出房间"
          >
            退出
          </button>
        </div>
      </header>

      <section className="felt-wrap">
        <div className="felt">
          {/* 牌桌本体单独一层并做透视倾斜；座位和底池留在不旋转的平面上，
              这样桌子有立体感，而文字和牌面不会跟着变形 */}
          <div className="felt-surface" aria-hidden="true">
            <div className="felt-cloth">
              <div className="felt-ring" />
            </div>
          </div>

          <div className="pot">
            <span>{room.phase === 'round_end' ? '本局彩池' : '底池'}</span>
            <strong>{fmt(pot)}</strong>
            <small>
              底注 {fmt(room.betUnit)}
              {room.phase === 'playing' ? ` · 第 ${room.roundNo}/${room.settings.maxRounds} 轮` : ''}
            </small>
          </div>

          {chips.map((c) => (
            <span
              key={c.id}
              className="fly-chip"
              style={{ ['--sx' as string]: c.left, ['--sy' as string]: c.top }}
            >
              +{fmt(c.amount)}
            </span>
          ))}

          {seated.slots.map(({ player, left, top }, k) => (
            <Seat
              key={player.id}
              player={player as PublicPlayer}
              style={{ left, top }}
              isMe={player.id === me.id}
              isHost={room.hostId === player.id}
              isTurn={room.phase === 'playing' && room.turnSeat === player.seat}
              deadline={room.turnDeadline}
              turnSeconds={room.settings.turnSeconds}
              handNo={room.handNo}
              showdownHand={showdownHands[player.id]}
              onPeek={player.id === me.id ? () => cmd({ type: 'look' }) : undefined}
            />
          ))}

          {seated.showInvite && (
            <EmptySeat
              style={seated.invitePos}
              onInvite={invite}
              onAddBot={room.hostId === me.id ? () => cmd({ type: 'add_bot' }) : undefined}
            />
          )}
        </div>
      </section>

      <ActionBar room={room} me={me as PublicPlayer} cmd={cmd} onInvite={invite} onInviteCli={inviteCli} />
      <EmoteBar cmd={cmd} />

      <Dock room={room} cmd={cmd} open={dockOpen} onToggle={setDockOpen} unread={unread} />

      {room.phase === 'round_end' && result && (
        <div className="result-scrim">
          <div className="result">
            <p className="result-cap">本局赢家</p>
            <div className="result-who">
              <span className="result-av">{room.players.find((p) => p.id === result.winnerId)?.avatar ?? '🏆'}</span>
              <h2>{result.winnerName}</h2>
            </div>
            <strong className="result-amount">+{fmt(result.potWon)}</strong>
            <span className="result-reason">{result.reason}</span>

            {result.revealed.length > 0 && (
              <div className="reveal-grid">
                {result.revealed.map((id) => {
                  const p = room.players.find((x) => x.id === id);
                  if (!p) return null;
                  const hands = showdownHands[id] ?? [];
                  return (
                    <div key={id} className={`reveal${id === result.winnerId ? ' won' : ''}`}>
                      <span>
                        {p.avatar} {p.name}
                        <i className="reveal-type">{hands.length === 3 ? evaluateHand(hands).name : ''}</i>
                      </span>
                      <div className="reveal-hand">
                        {hands.map((c, i) => (
                          <PlayingCard key={i} card={c} faceDown={false} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="result-next">
              {room.settings.autoContinue ? '稍后自动开始下一局' : '等待房主开启下一局'}
            </p>
            {room.hostId === me.id && (
              <button className="btn primary" onClick={() => cmd({ type: 'new_round' })}>
                立刻返回准备
              </button>
            )}
          </div>
        </div>
      )}

      {fx && (
        <div className={`fx fx-${fx.kind}`} key={fx.id} aria-hidden="true">
          <span className="fx-word">{fx.label}</span>
        </div>
      )}

      <footer className="fineprint">仅供好友娱乐 · 虚拟积分不可充值、转让、提现或兑换任何现实价值</footer>
    </main>
  );
}
