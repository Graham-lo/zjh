import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOTES } from '../../shared/game.ts';
import { GAME_META, ladderOf } from '../../shared/games.ts';
import { cardFromId, levelLabel, sortSjHand } from '../../shared/sj/cards.ts';
import type { SjCommand, SjPublicPlayer, SjPublicRoom, SjTrickRecord } from '../../shared/sj/engine.ts';
import { suggest } from '../../shared/sj/bot.ts';
import type { AccountInfo, AnyGameCommand, GameEvent } from '../../shared/protocol.ts';
import { PlayingCard } from '../components/Card.tsx';
import { Dock } from '../components/Dock.tsx';
import { GoldRain } from '../components/Fx.tsx';
import { IconCopy, IconExit, IconSoundOff, IconSoundOn, IconVoice, Laurel } from '../components/Icons.tsx';
import { TurnRing, useCountdown } from '../components/TurnRing.tsx';
import type { NetStatus } from '../net.ts';
import { sound, voice } from '../sound.ts';
import { DeclareBar } from './DeclareBar.tsx';
import { Hand } from './Hand.tsx';
import { KouDi, KouWaiting } from './KouDi.tsx';
import { Scoreboard, MiniBoard } from './Scoreboard.tsx';
import { SjFx, type SjFxJob } from './SjFx.tsx';
import { DeclaredCards, LastTrick, PlayZone } from './Trick.tsx';
import { useCountUp } from './useCountUp.ts';
import {
  TRUMP_TINT, TRUMP_VOICE, checkPlay, ctxOf, leadShape, leadText, seatBySpot, spotOf,
  teamOfSeat, throwFailText, trickPointsOf, trumpGlyph, trumpText, type SjSpot,
} from './util.ts';

/** 发牌动画的总长，和服务端的 SJ_DEAL_MS 是同一个数（45ms/张 × 25 张 + 余量） */
const DEAL_MS = 4600;
/** 收圈：金边亮 300ms 后四手牌叠飞向赢家 */
const COLLECT_MS = 1100;

/* --------------------------------------------------------------- 座位 */

function SeatCard({
  player,
  spot,
  room,
  isMe,
  isTurn,
  onSwap,
}: {
  player: SjPublicPlayer;
  spot: SjSpot;
  room: SjPublicRoom;
  isMe: boolean;
  isTurn: boolean;
  /** 大厅里点别人的座位就换过去，方便组队（DESIGN 1.3） */
  onSwap?: () => void;
}) {
  const myTeam = teamOfSeat(room.players.find((p) => p.id === room.viewerId)?.seat ?? 0);
  const sameTeam = teamOfSeat(player.seat) === myTeam;
  const isDealer = player.seat === room.dealerSeat;
  const cls = [
    'sj-seat', `sj-seat-${spot}`,
    isTurn && 'is-turn',
    isMe && 'is-me',
    onSwap && 'can-swap',
    !player.online && !player.isBot && 'is-offline',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} onClick={onSwap} title={onSwap ? '点一下和他换座（0/2 一队、1/3 一队）' : undefined}>
      <div className="sj-seat-av">
        {isTurn && <TurnRing deadline={room.turnDeadline} total={room.settings.turnSeconds} />}
        <span className="avatar-glyph">{player.avatar}</span>
        {isDealer && <span className="sj-dealer" title="庄家">庄</span>}
        {player.emote && (
          <span className="emote-pop" key={player.emote.at}>
            {player.emote.id}
          </span>
        )}
      </div>
      <div className="sj-seat-body">
        <div className="sj-seat-name">
          <b>{player.name}{isMe ? '（我）' : ''}</b>
          <span className={`sj-team${sameTeam ? ' mine' : ''}`}>{sameTeam ? '我方' : '对方'}</span>
        </div>
        <div className="sj-seat-sub">
          {room.phase === 'lobby'
            ? player.isBot ? '电脑' : player.ready ? '已准备' : '未准备'
            : `${isMe ? player.hand.length : player.handCount} 张`}
          {player.isBot && room.phase !== 'lobby' ? ' · 电脑' : ''}
          {!player.online && !player.isBot ? ' · 离线' : ''}
          {player.lastAction ? ` · ${player.lastAction}` : ''}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 大厅行动条 */

function LobbyBar({
  room,
  me,
  cmd,
  onInvite,
}: {
  room: SjPublicRoom;
  me: SjPublicPlayer;
  cmd(c: SjCommand): void;
  onInvite(): void;
}) {
  const isHost = room.hostId === me.id;
  const full = room.players.length === 4;
  const allReady = room.players.every((p) => p.isBot || (p.ready && p.online));
  return (
    <div className="sj-bar sj-lobby">
      <span className="sj-bar-cap">
        {room.players.length}/4 人 · 打 {levelLabel(room.trump.level)}
      </span>
      <button className={`btn ${me.ready ? 'ghost' : 'primary'}`} onClick={() => cmd({ type: 'ready', ready: !me.ready })}>
        {me.ready ? '取消准备' : '准备'}
      </button>
      {!full && (
        <>
          <button className="btn" onClick={onInvite}>邀请好友</button>
          {isHost && <button className="btn" onClick={() => cmd({ type: 'add_bot' })}>+ 电脑玩家</button>}
        </>
      )}
      {isHost && (
        <button className="btn primary" disabled={!full || !allReady} onClick={() => cmd({ type: 'start' })}>
          开始这一局
        </button>
      )}
      <span className="sj-bar-hint">
        {full ? (allReady ? '四个人都坐好了，房主开局' : '还有人没准备') : '四个座位坐满才能开局，可以加电脑补位'}
        {' · 0/2 一队、1/3 一队，点空座可以换座'}
      </span>
    </div>
  );
}

/** 房规：每局都会用到的东西不做下拉框，一排按钮点一下就改（用户偏好） */
function RuleBar({ room, cmd }: { room: SjPublicRoom; cmd(c: SjCommand): void }) {
  const s = room.settings;
  return (
    <div className="sj-rules">
      <span>出牌</span>
      {[15, 30, 60].map((n) => (
        <button key={n} className={`btn tiny${s.turnSeconds === n ? ' tier' : ''}`} onClick={() => cmd({ type: 'settings', turnSeconds: n })}>
          {n}s
        </button>
      ))}
      <span>扣底</span>
      {[30, 45, 90].map((n) => (
        <button key={n} className={`btn tiny${s.kouSeconds === n ? ' tier' : ''}`} onClick={() => cmd({ type: 'settings', kouSeconds: n })}>
          {n}s
        </button>
      ))}
      <button
        className={`btn tiny${s.autoContinue ? ' tier' : ''}`}
        onClick={() => cmd({ type: 'settings', autoContinue: !s.autoContinue })}
      >
        自动续局 {s.autoContinue ? '开' : '关'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ 主体 */

export function SjTable({
  room,
  cmd,
  status,
  latency,
  batch,
  onToast,
  account,
}: {
  room: SjPublicRoom;
  cmd(c: AnyGameCommand): void;
  status: NetStatus;
  latency: number;
  batch: { seq: number; events: GameEvent[] };
  onToast(msg: string): void;
  account: AccountInfo | null;
}) {
  const me = room.players.find((p) => p.id === room.viewerId);
  const mySeat = me?.seat ?? 0;
  const send = (c: SjCommand) => cmd(c);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hintIdx, setHintIdx] = useState(0);
  const [peek, setPeek] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [muted, setMuted] = useState(!sound.enabled);
  const [mutedVoice, setMutedVoice] = useState(!voice.enabled);
  const [dealAt, setDealAt] = useState(0);
  const [collect, setCollect] = useState<{ id: number; rec: SjTrickRecord } | null>(null);
  /** 扣底：8 张底牌从桌心飞向庄家（DESIGN 3.5） */
  const [kouFly, setKouFly] = useState<{ id: number; to: SjSpot; ids: string[] } | null>(null);
  /** 甩牌失败被退回的牌：抖两下再飞回手牌扇（DESIGN 3.5） */
  const [throwBack, setThrowBack] = useState<{ id: number; spot: SjSpot; cards: ReturnType<typeof cardFromId>[] } | null>(null);
  /** 我最后一次提交的出牌，甩牌被打回时用来算「哪几张退回来了」 */
  const lastPlay = useRef<string[]>([]);
  const prevPhase = useRef(room.phase);
  const prevHandIds = useRef<string[]>([]);
  /** 被反主撞飞的旧亮主牌：旋转滑出 900ms（DESIGN 3.5） */
  const [knocked, setKnocked] = useState<{ id: number; spot: SjSpot; cards: ReturnType<typeof cardFromId>[] } | null>(null);
  const prevDecl = useRef<{ id: string; cards: ReturnType<typeof cardFromId>[] } | null>(null);
  const [rain, setRain] = useState(0);
  const [shake, setShake] = useState(0);
  /** 结算面板要等牌桌把结算那一拍演完再升起来（沿用炸金花的两拍节奏） */
  const [panelUp, setPanelUp] = useState(false);
  const seen = useRef(0);
  const uid = useRef(0);

  /* 全屏特效的单车道队列：两个大字叠在一起谁也看不清（沿用炸金花的做法） */
  const [fx, setFx] = useState<{ id: number; job: SjFxJob } | null>(null);
  /** 队里还有没有没演完的特效。结算面板要等它清空（抠底那一段有 4.4s） */
  const [fxBusy, setFxBusy] = useState(false);
  const fxLive = useRef(false);
  const fxWait = useRef<SjFxJob[]>([]);

  const ctx = ctxOf(room);
  const hand = useMemo(() => (me ? sortSjHand(me.hand, ctx) : []), [me?.hand, ctx.trump, ctx.level]);
  const lead = useMemo(() => leadShape(room), [room.trick, room.trump.suit, room.trump.level]);
  const selectedCards = useMemo(() => hand.filter((c) => selected.has(c.id)), [hand, selected]);
  const seats = useMemo(() => seatBySpot(room, mySeat), [room.players, mySeat]);

  const myTurn = room.phase === 'playing' && room.turnSeat === mySeat;
  const isDealer = mySeat === room.dealerSeat;
  const kouMine = room.phase === 'kou' && isDealer;
  const check = useMemo(
    () => checkPlay(hand, selectedCards, lead, ctx),
    [hand, selectedCards, lead, ctx.trump, ctx.level],
  );

  /**
   * 建议出法（最多 5 个候选）。「提示」按钮循环它们，同时它的第一项就是**被动高亮**
   * 的那一手 —— 不点提示也知道该往哪儿选。只用自己的手牌和公开信息算，和机器人同源。
   */
  const hints = useMemo(
    () => (myTurn
      // mySeat / trickNo 是判断「领先的是不是对家」「是不是该抢了」的依据，缺一不可
      ? suggest({
        trump: room.trump, trick: room.trick, playedIds: room.playedIds,
        mySeat, trickNo: room.trickNo,
      }, hand, 5)
      : []),
    [myTurn, room.trick, room.playedIds, hand, room.trump, mySeat, room.trickNo],
  );
  /** 当前被建议的那一手，跟着「提示」的循环走 */
  const hintPick = hints.length ? hints[hintIdx % hints.length] : null;

  /* 换圈、换阶段、手牌变了就把选牌清掉，免得留着上一手的残影 */
  useEffect(() => setSelected(new Set()), [room.trickNo, room.phase, room.handNo]);
  useEffect(() => setHintIdx(0), [room.trickNo, room.turnSeat]);
  /**
   * 唯一解自动预选：轮到我、而 `suggest` 去重之后只剩一种打法时（跟牌时很常见 ——
   * 这门花色只剩一张、或者手里那一对必须整对跟出），直接把那一手选好。
   *
   * **只自动选，绝不自动出牌**：替人做决定和替人点确认是两回事，出牌永远等玩家按。
   * 依赖只有「轮次」，所以玩家把它取消掉之后不会又被选回来，不会粘住。
   */
  const turnKey = `${room.handNo}:${room.trickNo}:${room.trick.length}`;
  useEffect(() => {
    if (!myTurn || hints.length !== 1) return;
    const only = hints[0].map((c) => c.id);
    // 函数式更新：清空选牌的那个 effect 排在前面，这里看到的一定是清空之后的状态
    setSelected((s) => (s.size ? s : new Set(only)));
  }, [turnKey, myTurn, hints.length]);
  useEffect(() => {
    if (dockOpen) setUnread(0);
  }, [dockOpen]);
  /**
   * 结算面板等牌桌把这一拍演完再升起来（沿用炸金花开牌亮相的两拍节奏）。
   * 抠底那一段自己就要 4.4s，所以不是定长等待，而是等特效队列清空。
   */
  useEffect(() => {
    if (room.phase !== 'hand_end' && room.phase !== 'match_end') return setPanelUp(false);
    if (fxBusy) return;
    const t = setTimeout(() => setPanelUp(true), 450);
    return () => clearTimeout(t);
  }, [room.phase, room.handNo, fxBusy]);

  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '玩家';
  const seatOf = (id: string) => room.players.find((p) => p.id === id)?.seat ?? 0;

  function pushFx(job: SjFxJob) {
    setFxBusy(true);
    if (fxLive.current) {
      fxWait.current.push(job);
      return;
    }
    startFx(job);
  }
  function startFx(job: SjFxJob) {
    fxLive.current = true;
    setFxBusy(true);
    uid.current += 1;
    setFx({ id: uid.current, job });
    if (job.kind === 'dig') setShake((n) => n + 1);
  }
  function endFx() {
    fxLive.current = false;
    setFx(null);
    const next = fxWait.current.shift();
    if (next) setTimeout(() => !fxLive.current && startFx(next), 260);
    else setFxBusy(false);
  }

  /* 事件 → 音效与动画。状态永远以 room 为准，事件只负责表演（DESIGN 2.3 / 3.5） */
  useEffect(() => {
    if (batch.seq === seen.current) return;
    seen.current = batch.seq;
    for (const ev of batch.events) {
      switch (ev.k) {
        case 'sj_deal': {
          setDealAt(Date.now());
          // 每张一声极轻的 deal，音高逐张微升
          for (let i = 0; i < 12; i++) setTimeout(() => sound.play('deal', i % 6), i * 180);
          break;
        }
        case 'sj_declare': {
          // 反主：把上一个人亮的牌留在原地撞飞一下，再让新的拍下来
          const prev = prevDecl.current;
          if (prev && prev.id !== ev.playerId && prev.cards.length) {
            const id = ++uid.current;
            setKnocked({ id, spot: spotOf(seatOf(prev.id), mySeat), cards: prev.cards });
            setTimeout(() => setKnocked((k) => (k?.id === id ? null : k)), 900);
          }
          sound.play('slam');
          voice.play(ev.strength >= 2 && ev.trump !== 'NT' ? 'trump_pair' : TRUMP_VOICE[ev.trump]);
          navigator.vibrate?.([20, 40, 30]);
          pushFx({
            kind: 'declare', trump: ev.trump, who: nameOf(ev.playerId),
            strength: ev.strength, reinforce: ev.reinforce,
          });
          break;
        }
        case 'sj_flip': {
          sound.play('flip');
          voice.play(TRUMP_VOICE[ev.trump]);
          pushFx({ kind: 'flip', card: ev.card, trump: ev.trump });
          break;
        }
        case 'sj_kou_done':
          sound.play('sweep');
          if (ev.playerId === room.viewerId) voice.play('kou');
          break;
        case 'sj_play': {
          sound.play('deal', ev.cardIds.length);
          if (ev.trumped) {
            sound.play('clash');
            voice.play('bi');
            navigator.vibrate?.([25, 45]);
          }
          break;
        }
        case 'sj_throw_fail': {
          sound.play('stamp');
          // 退回的牌 = 我提交的那一把减去被强制留下的最小单位。
          // 别人甩失败时客户端看不到他试图甩了什么（手牌是暗的），只演戳记。
          if (ev.playerId === room.viewerId) {
            const back = lastPlay.current.filter((id) => !ev.forcedIds.includes(id));
            // 先把话说清楚：**最小的那一手已经打出去了**，飞回来的只是其余的牌。
            // 光看动效很容易误以为整把都没出成，那正是"甩牌失败＝没出牌"这个误解的来源。
            onToast(throwFailText(ev.forcedIds, back.length));
            if (back.length) {
              const id = ++uid.current;
              setThrowBack({ id, spot: spotOf(mySeat, mySeat), cards: back.map(cardFromId) });
              setTimeout(() => sound.play('shove'), 190);
              setTimeout(() => setThrowBack((t) => (t?.id === id ? null : t)), 820);
            }
          }
          pushFx({
            kind: 'throwFail', who: nameOf(ev.playerId),
            penalty: ev.penalty, forcedIds: [...ev.forcedIds],
          });
          break;
        }
        case 'sj_trick': {
          sound.play('sweep');
          if (room.lastTrick) setCollect({ id: ++uid.current, rec: room.lastTrick });
          setTimeout(() => setCollect(null), COLLECT_MS);
          // 分牌一张一声「叮」，音高上行，和分牌飞进记分板同步
          if (ev.points > 0) {
            const n = Math.min(6, Math.max(1, Math.round(ev.points / 5)));
            for (let i = 0; i < n; i++) setTimeout(() => sound.play('ding', i), 420 + i * 110);
          }
          break;
        }
        case 'sj_dig':
          sound.play('stamp');
          voice.play('dig');
          navigator.vibrate?.([40, 60, 40, 120]);
          pushFx({
            kind: 'dig', who: nameOf(ev.winnerId), base: ev.base,
            multiplier: ev.multiplier, total: ev.total, bottom: room.bottom,
          });
          break;
        case 'sj_hand_end': {
          const o = ev.outcome;
          voice.play(
            o.label === '大光' ? 'daguang'
              : o.label === '小光' ? 'xiaoguang'
                : o.defendersWin ? 'shangtai' : 'levelup',
          );
          sound.play(o.defendersWin === (teamOfSeat(mySeat) !== teamOfSeat(room.dealerSeat)) ? 'win' : 'lose');
          pushFx({
            kind: 'handEnd', label: o.label,
            detail: `闲家 ${ev.defenderPoints} 分${o.up ? ` · 升 ${o.up} 级` : ''}`,
            big: o.label === '大光' || o.label === '小光' || o.up >= 2,
          });
          break;
        }
        case 'sj_match_end': {
          const mine = ev.winnerTeam === teamOfSeat(mySeat);
          voice.play('tongguan');
          if (mine) setRain((n) => n + 1);
          pushFx({ kind: 'matchEnd', mine });
          break;
        }
        case 'sj_turn':
          if (ev.playerId === room.viewerId) {
            sound.play('turn');
            voice.play('turn');
            navigator.vibrate?.(30);
          }
          break;
        case 'sj_chat':
          if (!dockOpen) setUnread((u) => u + 1);
          sound.play('msg');
          break;
        default:
          break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.seq]);

  /**
   * 扣底：底牌是在服务端直接并进庄家手牌的，客户端只会看到手牌一下从 25 变 33。
   * 所以用 phase 进入 kou 这一下自己补一段飞牌 —— 非庄家看到 8 张牌背沿弧线
   * 飞向庄家座位，庄家看到它们飞到手牌区、逐张翻面，飞完才放进扇子里（随后 FLIP 重排）。
   */
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = room.phase;
    if (room.phase !== 'kou' || was === 'kou') return;
    const to = spotOf(room.dealerSeat, mySeat);
    const ids = to === 'me' ? hand.filter((c) => !prevHandIds.current.includes(c.id)).map((c) => c.id) : [];
    const id = ++uid.current;
    setKouFly({ id, to, ids });
    for (let i = 0; i < 8; i++) setTimeout(() => sound.play('deal', i), i * 70);
    const ms = to === 'me' ? 1700 : 1200;
    const t = setTimeout(() => setKouFly((k) => (k?.id === id ? null : k)), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.phase]);

  /* 这一句声明在上面那个 effect 之后，所以它读到的 prevHandIds 还是上一轮的手牌 */
  useEffect(() => {
    prevHandIds.current = hand.map((c) => c.id);
  });

  /* 记下「现在谁亮着什么牌」，下一次有人反主时拿它演撞飞。
     这个 effect 声明在事件 effect 之后，所以同一次提交里事件读到的仍是上一轮的值 */
  useEffect(() => {
    const d = room.trump.declarerId;
    const p = d ? room.players.find((x) => x.id === d) : null;
    prevDecl.current = p && p.declaredIds.length ? { id: p.id, cards: p.declaredIds.map(cardFromId) } : null;
  }, [room.trump.declarerId, room.trump.cardIds.join(',')]);

  /* 发牌动画只在开头那 4.6 秒里播 */
  const dealing = dealAt > 0 && Date.now() - dealAt < DEAL_MS;
  useEffect(() => {
    if (!dealAt) return;
    const t = setTimeout(() => setDealAt(0), DEAL_MS);
    return () => clearTimeout(t);
  }, [dealAt]);

  if (!me) return <div className="loading">正在回到牌桌…</div>;

  /* ---------------------------------------------------------- 交互 */

  /**
   * 整组切换：组里只要还有没选中的就补齐，全都选中了才整组取消。
   * 单击一张牌是「一张的组」；首出是对子时 Hand 会把它和它的对子作为一组传进来，
   * 所以自动配上的对子也能一下取消掉，不会出现「选不掉」的粘滞。
   */
  const toggle = (ids: string[]) =>
    setSelected((s) => {
      const next = new Set(s);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) allOn ? next.delete(id) : next.add(id);
      return next;
    });
  const selectMany = (ids: string[]) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });

  const doHint = () => {
    if (!hints.length) return onToast('这一手没有别的打法了');
    const pick = hints[hintIdx % hints.length];
    setHintIdx((i) => i + 1);
    setSelected(new Set(pick.map((c) => c.id)));
    sound.play('tap');
  };

  const doPlay = () => {
    if (!check.ok) return;
    const ids = hand.filter((c) => selected.has(c.id)).map((c) => c.id);
    lastPlay.current = ids;
    send({ type: 'play', cardIds: ids });
    setSelected(new Set());
  };

  const copy = (text: string, okMsg: string) => {
    navigator.clipboard?.writeText(text).then(() => onToast(okMsg)).catch(() => onToast(`房间号 ${room.code}`));
  };
  const invite = () => copy(`${location.origin}/?room=${room.code}`, '邀请链接已复制，发给好友即可');

  /* ---------------------------------------------------------- 渲染 */

  const tint = room.trump.suit ? TRUMP_TINT[room.trump.suit] : '#7f93b8';
  const trickPts = trickPointsOf(room);
  const label = GAME_META[room.kind].label;
  const result = room.result;
  const showResult = (room.phase === 'hand_end' || room.phase === 'match_end') && !!result && panelUp;
  // 一圈四家出牌张数相同，所以「已出 m/25」看自己手里还剩多少就够（DESIGN 1.4 修订）
  const playedTotal = Math.max(0, 25 - hand.length);

  const shellClass = [
    'table-shell', 'sj',
    fx?.job.kind === 'dig' && 'sj-shake',
    room.phase === 'playing' && myTurn && 'is-my-turn',
  ].filter(Boolean).join(' ');

  const declaredOf = (p?: SjPublicPlayer) =>
    p && p.declaredIds.length && room.phase !== 'playing'
      ? p.declaredIds.map(cardFromId)
      : [];

  return (
    <main className={shellClass} style={{ ['--sj-tint' as string]: tint }} data-trump={room.trump.suit ?? 'none'}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-chip" aria-hidden="true">♠</span>
          <b>{label}</b>
          <button className="room-pill" onClick={invite} title="点击复制邀请链接">
            房间 {room.code.slice(0, 3)} {room.code.slice(3)}
            <IconCopy size={13} />
          </button>
        </div>
        <div className="topbar-right">
          {account && (
            <span className="score-pill up" title="升级的累计局数与胜局，换房间也接着算">
              升级 {account.sjWins}/{account.sjHands} 胜
            </span>
          )}
          <span className={`net-pill net-${status}`} title={`延迟 ${latency}ms`}>
            <i />
            {status === 'online' ? `${latency}ms` : status === 'connecting' ? '连接中' : '重连中'}
          </span>
          <button
            className={`icon-btn${muted ? ' off' : ''}`}
            aria-label={muted ? '开启音效' : '关闭音效'}
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
              onClick={() => {
                const next = !mutedVoice;
                setMutedVoice(next);
                voice.unlock();
                voice.setEnabled(!next);
              }}
            >
              <IconVoice />
            </button>
          )}
          <button
            className="icon-btn danger wide"
            onClick={() =>
              window.confirm(
                room.phase === 'lobby' ? '确定退出房间？' : '牌局进行中，退出后座位由电脑接管到本场结束。确定？',
              ) && cmd({ type: 'leave' })
            }
            aria-label="退出房间"
          >
            <IconExit size={15} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <aside className="sj-left">
        <Scoreboard room={room} mySeat={mySeat} myHand={hand.length} />
      </aside>

      <section className="sj-mid">
        <MiniBoard room={room} mySeat={mySeat} />

        <div className="sj-felt-wrap">
          <div className="sj-felt">
            <div className="felt-surface sj-surface" aria-hidden="true">
              <div className="felt-cloth sj-cloth">
                <div className="felt-ring" />
              </div>
            </div>

            {/* 四个座位：我在下、对家在上、左右是对手 */}
            {(['top', 'left', 'right', 'me'] as SjSpot[]).map((spot) => {
              const p = seats[spot];
              if (!p) {
                return (
                  <div key={spot} className={`sj-seat sj-seat-${spot} sj-seat-empty`}>
                    <button className="btn tiny" onClick={invite}>邀请好友</button>
                    {room.hostId === me.id && (
                      <button className="btn tiny ghost" onClick={() => send({ type: 'add_bot' })}>+ 电脑</button>
                    )}
                  </div>
                );
              }
              return (
                <SeatCard
                  key={p.id}
                  player={p}
                  spot={spot}
                  room={room}
                  isMe={p.id === me.id}
                  isTurn={room.turnSeat === p.seat && (room.phase === 'playing' || room.phase === 'kou')}
                  onSwap={room.phase === 'lobby' && p.id !== me.id ? () => send({ type: 'seat', seat: p.seat }) : undefined}
                />
              );
            })}

            {/* 亮主的明牌摆在座位前，直到扣底结束 */}
            {(['top', 'left', 'right', 'me'] as SjSpot[]).map((spot) => (
              <DeclaredCards key={`d-${spot}`} spot={spot} cards={declaredOf(seats[spot])} />
            ))}
            {knocked && <DeclaredCards key={knocked.id} spot={knocked.spot} cards={knocked.cards} knocked />}

            {/* 扣底飞牌（非庄家视角）：8 张牌背从桌心沿弧线飞向庄家 */}
            {kouFly && kouFly.to !== 'me' && (
              <div className="sj-kou-fly" data-to={kouFly.to} key={kouFly.id} aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} className="sj-kou-fly-card" style={{ ['--i' as string]: i }}>
                    <PlayingCard faceDown size="play" />
                  </span>
                ))}
              </div>
            )}

            {/* 甩牌被打回：退回的牌抖两下再沿弧线飞回手牌扇 */}
            {throwBack && (
              <div className={`sj-throw-back sj-throw-back-${throwBack.spot}`} key={throwBack.id} aria-hidden="true">
                {throwBack.cards.map((c, i) => (
                  <span key={c.id} className="sj-throw-back-card" style={{ ['--i' as string]: i }}>
                    <PlayingCard card={c} faceDown={false} size="play" />
                  </span>
                ))}
              </div>
            )}

            {/* 当前圈：每手牌落在各自座位前 */}
            {!collect &&
              room.trick.map((play) => {
                const cards = play.cardIds.map(cardFromId);
                const trumped = !!lead && lead.group !== 'T' && cards.every((c) =>
                  (c.suit === 'J' || c.rank === room.trump.level || c.suit === room.trump.suit));
                return (
                  <PlayZone
                    key={play.seat}
                    spot={spotOf(play.seat, mySeat)}
                    cardIds={play.cardIds}
                    trumped={trumped}
                    note={trumped ? '毙' : undefined}
                  />
                );
              })}

            {/* 收圈：四手牌先金边亮一下，再整叠飞向赢家 */}
            {collect &&
              collect.rec.plays.map((play) => (
                <div
                  key={play.seat}
                  className="sj-collect"
                  data-to={spotOf(collect.rec.winnerSeat, mySeat)}
                  style={{ ['--i' as string]: play.seat }}
                >
                  <PlayZone
                    spot={spotOf(play.seat, mySeat)}
                    cardIds={play.cardIds}
                    won={play.seat === collect.rec.winnerSeat}
                  />
                </div>
              ))}

            {/* 桌心状态带：第几圈、首出什么、本圈多少分 */}
            {room.phase === 'playing' && (
              <div className="sj-status">
                第 {room.trickNo} 圈
                {lead && <> · 首出 <b>{leadText(lead)}</b></>}
                {' · 已出 '}<b>{playedTotal}/25</b>{' 张'}
                {trickPts > 0 && <> · 本圈 <b className="pts">{trickPts}</b> 分</>}
              </div>
            )}
            {room.phase === 'dealing' && <div className="sj-status">发牌中 · 亮主已经开放</div>}
            {room.phase === 'declaring' && <div className="sj-status">亮主窗口 · 无人亮主就翻底定主</div>}
            {room.phase === 'lobby' && (
              <div className="sj-status">
                {trumpText(null, room.trump.level)} · 坐满四人开局
              </div>
            )}

            {peek && room.lastTrick && <LastTrick room={room} last={room.lastTrick} mySeat={mySeat} />}
          </div>
        </div>

        {/* ------------------------------------------------ 行动区 */}
        <div className="sj-actions">
          {room.phase === 'lobby' && (
            <>
              <LobbyBar room={room} me={me} cmd={send} onInvite={invite} />
              {room.hostId === me.id && <RuleBar room={room} cmd={send} />}
            </>
          )}

          {(room.phase === 'dealing' || room.phase === 'declaring') && (
            <DeclareBar
              room={room}
              hand={hand}
              onDeclare={(ids) => send({ type: 'declare', cardIds: ids })}
              onPass={() => send({ type: 'pass' })}
            />
          )}

          {room.phase === 'kou' &&
            (kouMine ? (
              <KouDi
                room={room}
                hand={hand}
                selected={selectedCards}
                onFill={(ids) => setSelected(new Set(ids))}
                onConfirm={() => {
                  send({ type: 'kou', cardIds: selectedCards.map((c) => c.id) });
                  setSelected(new Set());
                }}
              />
            ) : (
              <KouWaiting room={room} />
            ))}

          {room.phase === 'playing' && (
            <div className={`sj-bar sj-play-bar${myTurn ? ' is-turn' : ''}`}>
              <TurnLine room={room} myTurn={myTurn} mySeat={mySeat} />
              <div className="sj-play-actions">
                <button className="btn tier" disabled={!myTurn} onClick={doHint}>
                  提示{hints.length > 1 ? ` ${(hintIdx % hints.length) + 1}/${hints.length}` : ''}
                </button>
                <button className="btn primary sj-go" disabled={!myTurn || !check.ok} onClick={doPlay}>
                  {check.label}
                </button>
                <button
                  className="btn ghost"
                  disabled={!room.lastTrick}
                  onPointerDown={() => setPeek(true)}
                  onPointerUp={() => setPeek(false)}
                  onPointerLeave={() => setPeek(false)}
                >
                  看上一轮
                </button>
              </div>
              {myTurn && !check.ok && selectedCards.length > 0 && <div className="sj-why">{check.reason}</div>}
            </div>
          )}
        </div>

        {/* ------------------------------------------------ 手牌 */}
        {hand.length > 0 && room.phase !== 'lobby' && (
          <div className={`sj-hand-wrap${dealing ? ' dealing' : ''}`}>
            <Hand
              cards={hand}
              selected={selected}
              // 还没动手时把建议的那一手标出来；一旦开始选牌就撤掉，
              // 免得金色描边和选中的金边混在一起分不清哪个是自己选的
              hinted={myTurn && !selected.size && hintPick ? new Set(hintPick.map((c) => c.id)) : undefined}
              hidden={kouFly?.to === 'me' ? new Set(kouFly.ids) : undefined}
              onToggle={toggle}
              onSelectMany={selectMany}
              pairPick={!!lead && (lead.pairs > 0 || lead.tractors.length > 0)}
              rows={typeof window !== 'undefined' && window.innerWidth <= 780 ? 2 : 1}
              disabled={room.phase === 'playing' && !myTurn}
              lifted={myTurn || kouMine}
            />
          </div>
        )}
      </section>

      <Dock room={room as never} cmd={cmd as never} open={dockOpen} onToggle={setDockOpen} unread={unread} />

      <div className="emote-bar sj-emotes">
        {EMOTES.map((e) => (
          <button key={e} className="emote-btn" onClick={() => send({ type: 'emote', id: e })} aria-label={`发送表情 ${e}`}>
            {e}
          </button>
        ))}
      </div>

      {/* 扣底飞牌（庄家视角）：飞到手牌区上方，逐张翻面，飞完才并进扇子 */}
      {kouFly && kouFly.to === 'me' && <KouFlyToMe key={kouFly.id} ids={kouFly.ids} />}

      {showResult && <SjResult room={room} mySeat={mySeat} cmd={send} />}

      {fx && <SjFx key={fx.id} job={fx.job} onDone={endFx} />}
      {rain > 0 && <GoldRain key={rain} />}
      {shake > 0 && <span hidden key={shake} />}
    </main>
  );
}

/**
 * 庄家看到的扣底飞牌：8 张牌背从屏幕中央（桌心）沿弧线落到手牌区，
 * 每张之间 70ms，落地前逐张翻面。飞完由 SjTable 把它们交还给手牌扇。
 */
function KouFlyToMe({ ids }: { ids: string[] }) {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setUp(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="sj-kou-fly to-me" aria-hidden="true">
      {ids.map((id, i) => (
        <span key={id} className="sj-kou-fly-card" style={{ ['--i' as string]: i }}>
          <PlayingCard card={cardFromId(id)} faceDown={!up} size="play" />
        </span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- 轮次提示 */

function TurnLine({ room, myTurn, mySeat }: { room: SjPublicRoom; myTurn: boolean; mySeat: number }) {
  const left = useCountdown(room.turnDeadline);
  const cur = room.players.find((p) => p.seat === room.turnSeat);
  const urgent = myTurn && left > 0 && left <= 8;
  return (
    <div className="sj-bar-status">
      {myTurn ? (
        <strong className={urgent ? 'urgent' : ''}>轮到你 · {left}s</strong>
      ) : (
        <strong className="dim">等 {cur?.name ?? '玩家'} 出牌…{room.turnSeat === mySeat ? '' : ` ${left}s`}</strong>
      )}
      <span>
        {trumpText(room.trump.suit, room.trump.level)} · 第 {room.trickNo} 圈
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- 结算面板 */

function SjResult({ room, mySeat, cmd }: { room: SjPublicRoom; mySeat: number; cmd(c: SjCommand): void }) {
  const r = room.result!;
  const myTeam = teamOfSeat(mySeat);
  const dealerTeam = teamOfSeat(r.dealerSeat);
  const defenders = (1 - dealerTeam) as 0 | 1;
  const iAmDefender = myTeam === defenders;
  const won = r.outcome.defendersWin === iAmDefender;
  const points = useCountUp(r.defenderPoints);
  const left = useCountdown(room.phase === 'hand_end' ? room.turnDeadline : null);
  const nextDealer = room.players.find((p) => p.seat === r.nextDealerSeat);
  // room.levels 已经是升级后的值；把升的那几级倒推回去就得到本局开打时的级别
  const ladder = ladderOf(room.kind);
  const upTeam = r.outcome.defendersWin ? defenders : dealerTeam;
  const before: [number, number] = [r.levelsAfter[0], r.levelsAfter[1]];
  if (r.outcome.up > 0) {
    const idx = Math.max(0, ladder.indexOf(r.levelsAfter[upTeam]) - r.outcome.up);
    before[upTeam] = ladder[Math.max(0, idx)];
  }
  const bar = Math.min(100, (r.defenderPoints / 200) * 100);

  return (
    <div className="result-scrim sj-result-scrim">
      <div className="result-light" aria-hidden="true" />
      <div className="result sj-result">
        <div className="hairline card" aria-hidden="true" />
        {room.phase === 'match_end' && <Laurel id="laurel-sj" />}
        <p className="result-cap">
          第 {r.handNo} 局 · 打 {levelLabel(room.trump.level)} · {trumpGlyph(room.trump.suit)} 主
        </p>
        <h2 className={won ? 'win' : 'lose'}>{room.phase === 'match_end' ? '通 关' : r.outcome.label}</h2>

        <div className="sj-res-levels">
          {[myTeam, 1 - myTeam].map((team) => {
            const up = before[team] !== r.levelsAfter[team];
            return (
              <div key={team} className={`sj-res-team${team === myTeam ? ' mine' : ''}`}>
                <span>{team === myTeam ? '我方' : '对方'}</span>
                <div className="sj-res-lv">
                  {/* 升级那一下要看得见：旧级别划掉，新级别翻面进来 */}
                  {up && <s>{levelLabel(before[team])}</s>}
                  {up && <em>→</em>}
                  <b key={r.levelsAfter[team]} className="sj-level-num">
                    {levelLabel(r.levelsAfter[team])}
                  </b>
                </div>
                {team === dealerTeam && <i>本局坐庄</i>}
              </div>
            );
          })}
        </div>

        <div className="sj-res-bar">
          <div className="sj-res-bar-head">
            <span>闲家得分</span>
            <span>0 · 80 · 120 · 160 · 200</span>
          </div>
          <div className="sj-res-track">
            <div className="sj-res-fill" style={{ width: `${bar}%` }}>
              <span style={{ left: '40%' }} />
              <span style={{ left: '60%' }} />
              <span style={{ left: '80%' }} />
            </div>
          </div>
          <div className="sj-res-foot">
            <span>
              圈内 {r.defenderPoints - (r.dig?.total ?? 0) - r.penaltyPoints} 分
              {r.dig ? ` + 抠底 ${r.dig.base} × ${r.dig.multiplier} = ${r.dig.total}` : ' · 底牌没被抠'}
              {r.penaltyPoints ? ` · 甩牌罚分 ${r.penaltyPoints > 0 ? '+' : ''}${r.penaltyPoints}` : ''}
            </span>
            <b>{points} 分</b>
          </div>
        </div>

        <div className="sj-res-players">
          {[...room.players].sort((a, b) => a.seat - b.seat).map((p) => {
            const team = teamOfSeat(p.seat);
            return (
              <div key={p.id} className={`sj-res-row${p.id === room.viewerId ? ' mine' : ''}`}>
                <span className="sj-res-av">{p.avatar}</span>
                <div>
                  <b>{p.name}{p.id === room.viewerId ? '（我）' : ''}</b>
                  <span className={team === defenders ? 'def' : 'dec'}>{team === defenders ? '闲家' : '庄家'}</span>
                  <div className="sj-res-note">
                    {p.seat === r.dealerSeat ? `本局庄家 · 底牌 ${r.bottomPoints} 分` : team === defenders ? '闲家阵营' : '庄家阵营'}
                  </div>
                </div>
                <b className="sj-res-pts" title="本队在圈里抓到的分（不含底牌与罚分）">
                  {r.trickPoints[team]}
                  <i>本队</i>
                </b>
              </div>
            );
          })}
        </div>

        {room.phase === 'match_end' ? (
          <div className="result-actions">
            {room.hostId === room.viewerId && (
              <button className="btn primary" onClick={() => cmd({ type: 'new_match' })}>再来一场</button>
            )}
            <button className="btn ghost" onClick={() => window.confirm('确定退出房间？') && cmd({ type: 'leave' })}>
              退出房间
            </button>
          </div>
        ) : (
          <div className="result-actions">
            <span className="result-next">
              {room.settings.autoContinue ? `下一局 ${left}s 后自动开始` : '等待房主开下一局'}
              {nextDealer ? ` · ${nextDealer.name} 坐庄` : ''}
            </span>
            {room.hostId === room.viewerId && (
              <button className="btn primary" onClick={() => cmd({ type: 'new_hand' })}>下一局</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
