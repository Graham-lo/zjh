import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateHand, type GameCommand, type PublicPlayer, type PublicRoom } from '../shared/game.ts';
import type { AccountInfo, GameEvent } from '../shared/protocol.ts';
import { ActionBar, EmoteBar } from './components/ActionBar.tsx';
import { Dock } from './components/Dock.tsx';
import { ChipStack, CompareDuel, GoldRain, ShoveFx, type DuelSide } from './components/Fx.tsx';
import { IconCopy, IconExit, IconSoundOff, IconSoundOn, IconVoice, Laurel } from './components/Icons.tsx';
import { EmptySeat, Seat } from './components/Seat.tsx';
import { useHurryTick } from './components/TurnRing.tsx';
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

/** 会滚动的数字。结算时一个个跳出来，比直接拍上去有戏得多。 */
function CountUp({ value, delay = 0, sign = false }: { value: number; delay?: number; sign?: boolean }) {
  const [start, setStart] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStart(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  const shown = useCountUp(start ? value : 0, 620);
  return (
    <>
      {sign && shown >= 0 ? '+' : ''}
      {fmt(shown)}
    </>
  );
}

interface FlyChip {
  id: number;
  left: string;
  top: string;
  count: number;
}

/**
 * 「开牌亮相 → 再结算」的两拍节奏。
 *
 * 一进 round_end 就把结算面板整屏拍上来，摊牌那几秒全场谁也没看见 ——
 * 所以先把牌桌演完：逐家翻牌（200ms 一档，赢家压轴）→ 牌型徽章弹出 →
 * 赢家金环爆闪、桂冠落下、金币流回筹码堆，这一整套差不多 3.2s。
 * 没有公开摊牌的局（全场弃牌收锅）没什么可看，短一点就够。
 */
const SHOWDOWN_HOLD_MS = 3200;
const QUIET_HOLD_MS = 1400;
/** 逐家翻牌的档距，和 styles.css 里 .pc-inner 的 --reveal-i 步长是同一个数 */
const REVEAL_STEP_MS = 200;
/** 最后一家翻完还要留出翻面本身的时间，赢家的庆祝才不会抢在牌前面 */
const REVEAL_TAIL_MS = 700;

/**
 * 排队播放的全屏特效。
 *
 * 同一时刻只允许一个 —— 两个大字叠在一起谁也看不清，
 * 后到的排队 300ms 再上，情绪反而更有层次。
 */
type FxJob =
  | { kind: 'shove'; who: string; amount: number }
  | { kind: 'duel'; left: DuelSide; right: DuelSide }
  | { kind: 'word'; label: string; tone: 'accept' | 'showdown' };

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

/** 一注该飞几枚筹码：加得越狠，桌上看到的钱越多 */
function chipCount(amount: number, unit: number) {
  if (amount >= unit * 4) return 3;
  if (amount >= unit * 2) return 2;
  return 1;
}

export function Table({
  room,
  cmd,
  status,
  latency,
  batch,
  onToast,
  account,
}: {
  room: PublicRoom;
  cmd(c: GameCommand): void;
  status: NetStatus;
  latency: number;
  batch: { seq: number; events: GameEvent[] };
  onToast(msg: string): void;
  account: AccountInfo | null;
}) {
  const me = room.players.find((p) => p.id === room.viewerId);
  const [dockOpen, setDockOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [chips, setChips] = useState<FlyChip[]>([]);
  const [flash, setFlash] = useState<'win' | 'lose' | null>(null);
  const [rain, setRain] = useState(0);
  const [coinFlow, setCoinFlow] = useState<{ id: number; left: string; top: string } | null>(null);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [potBump, setPotBump] = useState(false);
  const [muted, setMuted] = useState(!sound.enabled);
  const [mutedVoice, setMutedVoice] = useState(!voice.enabled);
  const seen = useRef(0);
  const chipId = useRef(0);

  /* 全屏特效的单车道队列 */
  const [fx, setFx] = useState<{ id: number; job: FxJob } | null>(null);
  const fxLive = useRef(false);
  const fxLiveJob = useRef<FxJob | null>(null);
  const fxWait = useRef<FxJob[]>([]);
  const fxId = useRef(0);
  /* 会盖住整张桌子的特效（比牌对决、梭哈）是否还占着屏幕：开牌亮相要等它让开 */
  const [fxBlocking, setFxBlocking] = useState(false);

  /* 开牌亮相的起算时刻；0 表示当前不在亮相 */
  const [revealAt, setRevealAt] = useState(0);
  /* 赢家的庆祝先记下来，等亮相那一拍到了再起爆 */
  const [pendingWin, setPendingWin] = useState<{ id: number; playerId: string; amount: number } | null>(null);
  const [panelUp, setPanelUp] = useState(false);

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

  const result = room.result;
  const showdownHands = result?.hands ?? {};

  useHurryTick(room.turnDeadline, room.phase === 'playing' && !!me && room.turnSeat === me.seat);

  /**
   * 开牌的翻牌顺序：其他人先翻，赢家压轴。
   * 每家差 200ms，靠一个 CSS 变量传给牌的翻面 transition-delay。
   */
  const revealOrder = useMemo(() => {
    const ids = result?.revealed ?? [];
    const rest = ids.filter((id) => id !== result?.winnerId);
    const order = result && ids.includes(result.winnerId) ? [...rest, result.winnerId] : rest;
    return new Map(order.map((id, i) => [id, i]));
  }, [result]);
  // 每次服务端推送 result 都是新对象，节拍只能挂在这个原始数值上，
  // 否则定时器会被反复重置，面板永远升不起来
  const revealCount = revealOrder.size;

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
          const count = ev.kind === 'all_in' ? 3 : chipCount(ev.amount, room.betUnit || 1);
          if (from) {
            const id = ++chipId.current;
            setChips((c) => [...c, { id, left: from.left, top: from.top, count }]);
            setTimeout(() => setChips((c) => c.filter((x) => x.id !== id)), 1000);
          }
          // 筹码是一枚枚落进池子的，音高逐枚往上走
          for (let i = 0; i < count; i++) setTimeout(() => sound.play('chip', i), 620 + i * 90);
          // 钱进池子这件事要看得见：底池数字被砸大一下
          setTimeout(() => {
            setPotBump(true);
            setTimeout(() => setPotBump(false), 340);
          }, 640);
          voice.play(ev.kind === 'all_in' ? 'allin' : ev.kind);
          if (ev.kind === 'all_in') {
            sound.play('shove');
            pushFx({ kind: 'shove', who: nameOf(ev.playerId), amount: ev.amount });
            navigator.vibrate?.([30, 60, 30, 120, 60]);
          } else if (ev.kind === 'accept') {
            pushFx({ kind: 'word', label: '接', tone: 'accept' });
            navigator.vibrate?.([20, 40, 20]);
          } else if (ev.kind === 'compare' && ev.targetId && ev.loserId) {
            sound.play('clash');
            pushFx(buildDuel(ev.playerId, ev.targetId, ev.loserId));
            navigator.vibrate?.([25, 50, 40]);
          }
          break;
        }
        case 'look':
          if (ev.playerId === room.viewerId) {
            sound.play('flip');
            // 金花及以上多一声「叮」，跟徽章的金色波纹同时到
            const h = room.players.find((p) => p.id === ev.playerId)?.hand;
            if (h?.length === 3 && evaluateHand(h).category >= 4) setTimeout(() => sound.play('ding'), 760);
          }
          break;
        case 'fold':
          voice.play('fold');
          break;
        case 'turn':
          // 只有提示音，没有语音 —— 「该你啦」每局要念几十遍，是最先被关掉的一句
          if (ev.playerId === room.viewerId) {
            sound.play('turn');
            navigator.vibrate?.(30);
          }
          break;
        case 'showdown': {
          pushFx({ kind: 'word', label: '开 牌', tone: 'showdown' });
          // 开牌这一下是全场最有戏的时刻，直接把赢家的牌型念出来
          const hand = room.result?.hands[ev.winnerId];
          if (hand?.length === 3) voice.play(HAND_VOICE[evaluateHand(hand).name] ?? 'sanpai');
          break;
        }
        case 'win':
          // 庆祝不在这里放：牌可能还没翻完，比牌的全屏对决也可能还在演。
          // 交给下面的「开牌亮相」那一拍统一起爆，见 revealAt。
          setPendingWin({ id: ++chipId.current, playerId: ev.playerId, amount: ev.amount });
          break;
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

  /**
   * 开牌亮相的起算点：结算已经开始，且比牌/梭哈的全屏特效已经让开
   * （两个高潮叠在一起谁也看不清）。一旦起算就不再重算；
   * phase 中途回到 lobby/playing 时归零，下面几个定时器随 cleanup 一起清掉。
   */
  useEffect(() => {
    // 局都翻篇了还留着上一局的庆祝，下一局开头会莫名其妙爆一下金环
    if (room.phase !== 'round_end') setPendingWin(null);
    if (room.phase !== 'round_end' || fxBlocking) {
      setRevealAt(0);
      return;
    }
    setRevealAt((t) => t || Date.now());
  }, [room.phase, fxBlocking]);

  /** 牌桌把这一拍演完，结算面板才升起来 */
  useEffect(() => {
    if (!revealAt) {
      setPanelUp(false);
      return;
    }
    const t = setTimeout(() => setPanelUp(true), revealCount > 1 ? SHOWDOWN_HOLD_MS : QUIET_HOLD_MS);
    return () => clearTimeout(t);
  }, [revealAt, revealCount]);

  /**
   * 赢家压轴：等各家的牌都翻完，再爆金环、落桂冠、洒金币。
   * 这一整套是一局牌的封面，必须发生在没有遮罩的桌面上。
   */
  useEffect(() => {
    if (!pendingWin || !revealAt) return;
    const steps = Math.max(0, revealCount - 1);
    const t = setTimeout(() => {
      setWinnerId(pendingWin.playerId);
      setTimeout(() => setWinnerId(null), 1800);
      // 底池的钱化成一串金币，沿弧线飞进赢家的筹码堆
      const to = seated.posById.get(pendingWin.playerId);
      if (to && pendingWin.amount > 0) {
        setCoinFlow({ id: pendingWin.id, left: to.left, top: to.top });
        for (let i = 0; i < 3; i++) setTimeout(() => sound.play('coin', i), 240 + i * 150);
        setTimeout(() => setCoinFlow((c) => (c?.id === pendingWin.id ? null : c)), 1500);
      }
      const mine = pendingWin.playerId === room.viewerId;
      const played = me && me.bet > 0;
      if (mine) {
        sound.play('win');
        setFlash('win');
        setRain((n) => n + 1); // 只有自己赢才下金雨，输的人不该被再淋一次
      } else if (played) {
        sound.play('lose');
        setFlash('lose');
      }
      setTimeout(() => setFlash(null), 1600);
      setPendingWin(null);
    }, steps * REVEAL_STEP_MS + (steps ? REVEAL_TAIL_MS : 0));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWin, revealAt, revealCount]);

  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '玩家';

  /** 把一次比牌整理成对决双方。牌看不看得到由服务端的定向可见决定 */
  function buildDuel(challengerId: string, targetId: string, loserId: string): FxJob {
    const side = (id: string): DuelSide => {
      const p = room.players.find((x) => x.id === id);
      return {
        name: p?.name ?? '玩家',
        avatar: p?.avatar ?? '🂠',
        hand: p?.hand?.length === 3 ? p.hand : [],
        won: id !== loserId,
      };
    };
    return { kind: 'duel', left: side(challengerId), right: side(targetId) };
  }

  /**
   * 砸字是半透明的一瞬，透过它照样看得见牌桌；
   * 对决和梭哈会把整张桌子盖住，开牌亮相必须等它们让开。
   */
  const blocksTable = (job: FxJob) => job.kind !== 'word';

  function syncBlocking() {
    const live = fxLiveJob.current;
    setFxBlocking((!!live && blocksTable(live)) || fxWait.current.some(blocksTable));
  }

  /** 入队一个全屏特效；有正在播的就等它演完再上 */
  function pushFx(job: FxJob) {
    if (fxLive.current) {
      fxWait.current.push(job);
      syncBlocking();
      return;
    }
    startFx(job);
  }

  function startFx(job: FxJob) {
    fxLive.current = true;
    fxLiveJob.current = job;
    fxId.current += 1;
    setFx({ id: fxId.current, job });
    syncBlocking();
    // 「接」「开牌」这类砸字没有自己的生命周期，由这里统一收场
    if (job.kind === 'word') setTimeout(() => endFx(), 1150);
  }

  function endFx() {
    fxLive.current = false;
    fxLiveJob.current = null;
    setFx(null);
    // 队头要留在队列里直到真的上场：中间这 300ms 的空档不算"特效演完了"
    if (fxWait.current.length) {
      setTimeout(() => {
        if (fxLive.current) return;
        const next = fxWait.current.shift();
        if (next) startFx(next);
      }, 300);
    }
    syncBlocking();
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

  // 底池越大，桌心的暖光越亮：三档，够读出「这锅值钱了」又不至于刺眼
  const heat = room.pot >= room.betUnit * 12 ? 2 : room.pot >= room.betUnit * 5 ? 1 : 0;
  const shellClass = [
    'table-shell',
    flash && `flash-${flash}`,
    fx?.job.kind === 'shove' && 'shake',
    room.allIn && 'allin-live', // 梭哈的余韵：底池换火焰橙，表态条心跳，直到局终
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <main className={shellClass}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-chip" aria-hidden="true">
            ♠
          </span>
          <b>好友炸金花</b>
          <button className="room-pill" onClick={invite} title="点击复制邀请链接">
            房间 {room.code.slice(0, 3)} {room.code.slice(3)}
            <IconCopy size={13} />
          </button>
        </div>
        <div className="topbar-right">
          {(() => {
            // 用牌桌上的实时数据算，而不是入座时那份账户快照 —— 否则打完一局数字还是旧的
            const lifetime = me ? me.chips - me.granted : account ? account.chips - account.granted : null;
            if (lifetime == null) return null;
            return (
              <span
                className={`score-pill ${lifetime >= 0 ? 'up' : 'down'}`}
                title={`累计发放 ${fmt(me ? me.granted : account!.granted)}，当前 ${fmt(me ? me.chips : account!.chips)}。换房间也接着算。`}
              >
                净战绩 {lifetime >= 0 ? '+' : ''}
                {fmt(lifetime)}
              </span>
            );
          })()}
          <span className={`net-pill net-${status}`} title={`延迟 ${latency}ms`}>
            <i />
            {status === 'online' ? `${latency}ms` : status === 'connecting' ? '连接中' : '重连中'}
          </span>
          <button
            className={`icon-btn${muted ? ' off' : ''}`}
            aria-label={muted ? '开启音效' : '关闭音效'}
            title={muted ? '音效已关闭' : '音效已开启'}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              sound.setEnabled(!next);
            }}
          >
            {muted ? <IconSoundOff /> : <IconSoundOn />}
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
                voice.setEnabled(!next, 'call');
              }}
            >
              <IconVoice />
            </button>
          )}
          <button
            className="icon-btn danger wide"
            onClick={() =>
              window.confirm(
                // 牌局进行中退出＝弃牌离场（服务端如此结算），弹窗里要把这层代价说清楚
                room.phase === 'playing' && me.status === 'active'
                  ? '正在牌局中，退出将自动弃牌并离开房间。确定？'
                  : '确定退出房间？',
              ) && cmd({ type: 'leave' })
            }
            aria-label="退出房间"
          >
            <IconExit size={15} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <section className="felt-wrap">
        <div className="felt" data-heat={heat}>
          {/* 牌桌本体单独一层并做透视倾斜；座位和底池留在不旋转的平面上，
              这样桌子有立体感，而文字和牌面不会跟着变形 */}
          <div className="felt-surface" aria-hidden="true">
            <div className="felt-cloth">
              <div className="felt-ring" />
              <div className="felt-crest">♠</div>
            </div>
          </div>
          <div className="felt-heat" aria-hidden="true" />

          <div className={`pot${potBump ? ' bumped' : ''}`}>
            <span>{room.phase === 'round_end' ? '本 局 彩 池' : '底 池'}</span>
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
              <ChipStack count={c.count} />
            </span>
          ))}

          {coinFlow && (
            <div className="coin-flow" key={coinFlow.id} aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <i
                  key={i}
                  style={{
                    ['--tx' as string]: coinFlow.left,
                    ['--ty' as string]: coinFlow.top,
                    ['--cd' as string]: `${i * 46}ms`,
                  }}
                />
              ))}
            </div>
          )}

          {seated.slots.map(({ player, left, top }) => (
            <Seat
              key={player.id}
              player={player as PublicPlayer}
              style={{ left, top, ['--reveal-i' as string]: revealOrder.get(player.id) ?? 0 }}
              isMe={player.id === me.id}
              isHost={room.hostId === player.id}
              isTurn={room.phase === 'playing' && room.turnSeat === player.seat}
              playing={room.phase === 'playing'}
              deadline={room.turnDeadline}
              turnSeconds={room.settings.turnSeconds}
              handNo={room.handNo}
              showdownHand={showdownHands[player.id]}
              onPeek={player.id === me.id ? () => cmd({ type: 'look' }) : undefined}
              celebrating={player.id === winnerId}
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

      {/* 面板要等牌桌把开牌演完再升起来：直接盖上去，摊牌那几秒全场都白演了 */}
      {room.phase === 'round_end' && result && panelUp && (
        <div className="result-scrim">
          <div className="result-light" aria-hidden="true" />
          <div className="result">
            <div className="hairline card" aria-hidden="true" />
            <p className="result-cap">本 局 赢 家</p>
            <div className="result-who">
              <span className="result-av">
                <Laurel id="laurel-result" />
                {room.players.find((p) => p.id === result.winnerId)?.avatar ?? '🏆'}
              </span>
              <h2>{result.winnerName}</h2>
              <span className="result-reason">{result.reason}</span>
            </div>
            <strong className="result-amount">
              +<CountUp value={result.potWon} delay={200} />
            </strong>

            {/* 自己的盈亏单独拎出来，不用在表格里找 */}
            {(() => {
              const mine = result.deltas?.find((d) => d.id === room.viewerId);
              if (!mine) return null;
              return (
                <div className={`my-result ${mine.delta >= 0 ? 'up' : 'down'}`}>
                  <span>你 本 局</span>
                  <strong>
                    <CountUp value={mine.delta} sign delay={140} />
                  </strong>
                  <small>
                    投入 {fmt(mine.bet)}（含底注 {fmt(room.settings.ante)}） · 本桌累计{' '}
                    {mine.net >= 0 ? '+' : ''}
                    {fmt(mine.net)}
                  </small>
                </div>
              );
            })()}

            {/* 本局每个人赢了多少输了多少，外加这一桌坐下以来的累计 */}
            {result.deltas?.length > 0 && (
              <div className="score-table">
                <div className="score-head">
                  <span>玩家</span>
                  <span>投入</span>
                  <span>本局</span>
                  <span>本桌累计</span>
                </div>
                {result.deltas.map((d, i) => {
                  const hand = showdownHands[d.id];
                  return (
                    <div
                      key={d.id}
                      className={`score-row${d.id === room.viewerId ? ' mine' : ''}${d.id === result.winnerId ? ' won' : ''}`}
                      style={{ ['--i' as string]: i }}
                    >
                      <span className="score-who">
                        {d.avatar} {d.name}
                        {hand?.length === 3 && <i className="reveal-type">{evaluateHand(hand).name}</i>}
                      </span>
                      <span className="score-bet">{fmt(d.bet)}</span>
                      <span className={`score-delta ${d.delta >= 0 ? 'up' : 'down'}`}>
                        <CountUp value={d.delta} sign delay={420 + i * 160} />
                      </span>
                      <span className={`score-net ${d.net >= 0 ? 'up' : 'down'}`}>
                        <CountUp value={d.net} sign delay={520 + i * 160} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="result-next">
              {room.settings.autoContinue ? '稍后自动开始下一局' : '等待房主开启下一局'}
            </p>
            <div className="result-actions">
              {room.hostId === me.id && (
                <button className="btn primary" onClick={() => cmd({ type: 'new_round' })}>
                  立刻返回准备
                </button>
              )}
              {/* 结算遮罩会挡住顶栏，这里也得能直接走人 */}
              <button className="btn ghost" onClick={() => window.confirm('确定退出房间？') && cmd({ type: 'leave' })}>
                退出房间
              </button>
            </div>
          </div>
        </div>
      )}

      {fx?.job.kind === 'shove' && (
        <ShoveFx key={fx.id} who={fx.job.who} amount={fx.job.amount} onDone={endFx} />
      )}
      {fx?.job.kind === 'duel' && (
        <CompareDuel key={fx.id} left={fx.job.left} right={fx.job.right} onDone={endFx} />
      )}
      {fx?.job.kind === 'word' && (
        <div className={`fx fx-${fx.job.tone}`} key={fx.id} aria-hidden="true">
          <span className="fx-word">{fx.job.label}</span>
        </div>
      )}

      {flash === 'win' && <GoldRain key={rain} />}

      <footer className="fineprint">仅供好友娱乐 · 虚拟积分不可充值、转让、提现或兑换任何现实价值</footer>
    </main>
  );
}
