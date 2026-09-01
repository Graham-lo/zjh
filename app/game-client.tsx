"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Card = { suit: 'S' | 'H' | 'C' | 'D'; rank: number };
type Player = { id: string; name: string; seat: number; chips: number; ready: boolean; status: 'waiting' | 'active' | 'folded'; looked: boolean; hand: Card[]; isBot: boolean; pendingLeave?: boolean; lastAction?: string };
type Room = {
  code: string; hostId: string; phase: 'lobby' | 'playing' | 'round_end'; players: Player[]; dealerSeat: number; turnSeat: number | null;
  pot: number; betUnit: number; turnCount: number; compareUnlockAt: number; handNo: number;
  settings: { maxPlayers: number; startingChips: number; ante: number; betOptions: number[]; special235: boolean };
  log: { seq: number; at: number; text: string }[];
  result?: { winnerId: string; winnerName: string; potWon: number; reason: string; hands: Record<string, Card[]> };
};
type Auth = { playerId: string; token: string };

const suitMap = { S: '♠', H: '♥', C: '♣', D: '♦' } as const;
const rankMap: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const seatClasses = ['seat-bottom', 'seat-br', 'seat-tr', 'seat-top', 'seat-tl', 'seat-bl'];

function storageKey(code: string) { return `friends-zjh:${code}`; }
function fmt(n: number) { return n.toLocaleString('zh-CN'); }

async function requestApi(payload: any) {
  const res = await fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json() as any; if (!res.ok) throw new Error(data.error || '请求失败'); return data;
}

function CardView({ card, back = false }: { card?: Card; back?: boolean }) {
  if (back || !card) return <div className="card card-back"><span>◆</span></div>;
  const red = card.suit === 'H' || card.suit === 'D';
  return <div className={`card ${red ? 'red' : ''}`}><b>{rankMap[card.rank] ?? card.rank}</b><span>{suitMap[card.suit]}</span></div>;
}

function Hand({ player, reveal }: { player: Player; reveal: boolean }) {
  if (reveal && player.hand?.length === 3) return <div className="mini-hand">{player.hand.map((c, i) => <CardView key={i} card={c} />)}</div>;
  if (player.status === 'waiting') return <div className="folded-mark waiting-mark">等待下局</div>;
  if (player.status === 'folded') return <div className="folded-mark">已弃牌</div>;
  return <div className="mini-hand">{[0,1,2].map((i) => <CardView key={i} back />)}</div>;
}

export default function GameClient() {
  const [room, setRoom] = useState<Room | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [inviteMode, setInviteMode] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [toast, setToast] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [raiseUnit, setRaiseUnit] = useState<number | null>(null); const pollRef = useRef<number | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null); const busyRef = useRef(false); const versionRef = useRef(-1);
  const knownPlayersRef = useRef<{ code: string; ids: Set<string> } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const me = useMemo(() => room?.players.find((p) => p.id === auth?.playerId) ?? null, [room, auth]);
  const isHost = !!room && room.hostId === auth?.playerId;
  const myTurn = !!room && !!me && room.phase === 'playing' && room.turnSeat === me.seat && me.status === 'active';
  const callCost = room && me ? room.betUnit * (me.looked ? 2 : 1) : 0;
  const activeCount = room?.players.filter((p) => p.status === 'active').length ?? 0;
  const compareUnlocked = !!room && (activeCount === 2 || room.turnCount >= room.compareUnlockAt);
  const comparePrice = callCost * 2;
  const canCompare = !!room && !!me && myTurn && compareUnlocked && activeCount > 1 && me.chips >= comparePrice;
  const canAllIn = !!me && myTurn && me.chips > 0 && me.chips <= callCost;

  const loadState = useCallback(async (code: string, a: Auth, quiet = false, signal?: AbortSignal) => {
    try {
      const qs = new URLSearchParams({ code, playerId: a.playerId });
      const res = await fetch(`/api/game?${qs}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${a.token}` },
        signal,
      });
      const data = await res.json() as any;
      if (!res.ok) throw new Error(data.error || '同步失败');
      if ((data.version ?? 0) >= versionRef.current) {
        versionRef.current = data.version ?? 0; setRoom(data.room); setLastSyncedAt(Date.now());
      }
      if (!quiet) setError('');
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      if (!quiet) setError(e.message || '同步失败');
    }
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('room')?.trim() ?? '';
    if (/^\d{6}$/.test(code)) {
      setJoinCode(code); setInviteMode(true); const raw = localStorage.getItem(storageKey(code));
      if (raw) { try { const a = JSON.parse(raw) as Auth; setAuth(a); loadState(code, a); } catch {} }
    }
  }, [loadState]);

  useEffect(() => {
    if (!room || !auth) return;
    let stopped = false;
    const schedule = (delay: number) => { if (!stopped) pollRef.current = window.setTimeout(tick, delay); };
    const tick = async () => {
      if (busyRef.current) { schedule(150); return; }
      const controller = new AbortController(); pollAbortRef.current = controller;
      await loadState(room.code, auth, true, controller.signal);
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
      schedule(document.hidden ? 1800 : 550);
    };
    schedule(250);
    return () => {
      stopped = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      pollAbortRef.current?.abort(); pollAbortRef.current = null;
    };
  }, [room?.code, auth, loadState]);

  useEffect(() => { if (room) setRaiseUnit(room.settings.betOptions.find((x) => x > room.betUnit) ?? null); }, [room?.betUnit]);

  useEffect(() => {
    if (!room) { knownPlayersRef.current = null; return; }
    const currentIds = new Set(room.players.map((p) => p.id));
    const previous = knownPlayersRef.current;
    if (previous?.code === room.code) {
      const joined = room.players.filter((p) => !previous.ids.has(p.id));
      if (joined.length) {
        setToast(`${joined.map((p) => p.name).join('、')} 已加入房间`);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setToast(''), 2200);
      }
    }
    knownPlayersRef.current = { code: room.code, ids: currentIds };
  }, [room?.code, room?.players]);

  async function create() {
    busyRef.current = true; setBusy(true); setError(''); try {
      const data = await requestApi({ op: 'create' }); const a = data.auth as Auth; setAuth(a); setRoom(data.room);
      versionRef.current = data.version ?? 0; setLastSyncedAt(Date.now()); setInviteMode(false);
      localStorage.setItem(storageKey(data.room.code), JSON.stringify(a)); history.replaceState(null, '', `?room=${data.room.code}`);
    } catch (e: any) { setError(e.message); } finally { busyRef.current = false; setBusy(false); }
  }

  async function join() {
    busyRef.current = true; setBusy(true); setError(''); try {
      const data = await requestApi({ op: 'join', code: joinCode }); const a = data.auth as Auth; setAuth(a); setRoom(data.room);
      versionRef.current = data.version ?? 0; setLastSyncedAt(Date.now());
      localStorage.setItem(storageKey(data.room.code), JSON.stringify(a)); history.replaceState(null, '', `?room=${data.room.code}`);
    } catch (e: any) { setError(e.message); } finally { busyRef.current = false; setBusy(false); }
  }

  async function act(command: any) {
    if (!room || !auth || busyRef.current) return;
    busyRef.current = true; pollAbortRef.current?.abort(); setBusy(true); setError('');
    try {
      const data = await requestApi({ op: 'action', code: room.code, ...auth, command });
      if (command.type === 'leave') { localStorage.removeItem(storageKey(room.code)); setRoom(null); setAuth(null); history.replaceState(null, '', location.pathname); }
      else if (data.room) { versionRef.current = data.version ?? versionRef.current; setRoom(data.room); setLastSyncedAt(Date.now()); }
    } catch (e: any) { setError(e.message || '操作失败'); } finally { busyRef.current = false; setBusy(false); }
  }

  async function copyInvite() {
    if (!room) return; const url = `${location.origin}${location.pathname}?room=${room.code}`;
    try { await navigator.clipboard.writeText(url); setToast('邀请链接已复制'); setTimeout(() => setToast(''), 1600); } catch { setToast(`房间号：${room.code}`); }
  }

  if (!room || !auth || !me) {
    return <main className="landing">
      <section className="brand-panel">
        <div className="brand-mark">♠</div><p className="eyebrow">FRIENDS TABLE</p><h1>好友炸金花</h1>
        <p className="lead">2–6 人私人房间。虚拟积分只用于娱乐，不充值、不转让、不提现、不兑换。</p>
        <div className="rules-strip"><span>豹子</span><i>›</i><span>同花顺</span><i>›</i><span>同花</span><i>›</i><span>顺子</span><i>›</i><span>对子</span><i>›</i><span>单张</span></div>
      </section>
      <section className="entry-card">
        <h2>{inviteMode ? '加入好友房间' : '进入牌桌'}</h2><p className="auto-name">系统将自动分配牌友昵称，加入后直接开玩。</p>
        {inviteMode ? <>
          <div className="invite-target"><span>受邀房间</span><strong>{joinCode}</strong></div>
          <button className="primary" disabled={busy} onClick={join}>加入房间 {joinCode}</button>
          <button className="secondary" disabled={busy} onClick={create}>不加入，自己创建房间</button>
        </> : <>
          <button className="primary" disabled={busy} onClick={create}>创建私人房间</button>
          <div className="divider"><span>或加入好友</span></div>
          <label>6 位房间号</label><input inputMode="numeric" value={joinCode} maxLength={6} placeholder="628731" onChange={(e) => setJoinCode(e.target.value.replace(/\D/g,'').slice(0,6))} />
          <button className="secondary" disabled={busy || joinCode.length !== 6} onClick={join}>加入房间</button>
        </>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>;
  }

  const displayPlayers = room.players.map((p) => ({ ...p, relSeat: (p.seat - me.seat + room.settings.maxPlayers) % room.settings.maxPlayers }));
  const revealAll = room.phase === 'round_end';

  return <main className="game-shell">
    <header className="topbar">
      <div><b>好友炸金花</b><span className="room-pill">房间 {room.code}</span></div>
      <div className="top-actions"><span className="online-pill" title={lastSyncedAt ? `最近同步：${new Date(lastSyncedAt).toLocaleTimeString('zh-CN')}` : '正在同步'}><i />{room.players.length} 人已同步</span>{busy && <span className="sync-pill">处理中…</span>}<button disabled={busy} onClick={copyInvite}>复制邀请</button><button disabled={busy} className="danger-link" onClick={() => act({ type: 'leave' })}>退出</button></div>
    </header>

    <section className="table-wrap">
      <div className="felt-table"><div className="table-ring" />
        <div className="pot-box"><span>{room.phase === 'round_end' ? '本局结束' : '底池'}</span><strong>{room.phase === 'round_end' ? `+${fmt(room.result?.potWon ?? 0)}` : fmt(room.pot)}</strong><small>当前盲注档 {fmt(room.betUnit)}</small></div>
        {displayPlayers.map((p) => <div key={p.id} className={`seat ${seatClasses[p.relSeat]} ${room.turnSeat === p.seat && room.phase === 'playing' ? 'turn' : ''} ${p.id === me.id ? 'me' : ''}`}>
          <div className="avatar">{p.isBot ? 'AI' : p.name.slice(0,1).toUpperCase()}</div>
          <div className="seat-info"><div className="name-row"><b>{p.name}</b>{room.hostId === p.id && <span className="host-tag">房主</span>}{p.isBot && <span className="bot-tag">电脑</span>}</div><span>{fmt(p.chips)} 分</span>{p.lastAction && <small>{p.lastAction}</small>}</div>
          {room.phase === 'playing' || revealAll ? <Hand player={p} reveal={revealAll || (p.id === me.id && p.looked)} /> : <div className={`ready-chip ${p.ready || p.isBot ? 'ready' : ''}`}>{p.ready || p.isBot ? '已准备' : '未准备'}</div>}
        </div>)}
      </div>
    </section>

    <section className="control-panel">
      {room.phase === 'lobby' && <>
        <div className="status-line"><strong>{room.players.length}/{room.settings.maxPlayers} 人</strong><span>底注 {fmt(room.settings.ante)} · 起始积分 {fmt(room.settings.startingChips)}</span></div>
        <div className="control-row">
          <button className={me.ready ? 'secondary' : 'primary'} onClick={() => act({ type: 'ready', ready: !me.ready })}>{me.ready ? '取消准备' : '准备'}</button>
          {me.chips < room.settings.ante && <button onClick={() => act({ type: 'reset_chips' })}>补充积分</button>}
          {isHost && room.players.length < room.settings.maxPlayers && <button onClick={() => act({ type: 'add_bot' })}>+ 电脑玩家</button>}
          {isHost && <button className="primary start" disabled={room.players.length < 2 || room.players.some((p) => !p.isBot && !p.ready)} onClick={() => act({ type: 'start' })}>开始游戏</button>}
        </div>
        {isHost && <div className="manage-list">{room.players.filter((p) => p.id !== me.id).map((p) => <span key={p.id}>{p.name}<button onClick={() => act({ type: 'remove_player', targetId: p.id })}>移除</button></span>)}</div>}
      </>}

      {room.phase === 'playing' && <>
        <div className="turn-banner">{me.status === 'waiting' ? <strong>已加入，等待下一局</strong> : myTurn ? <strong>轮到你行动</strong> : <span>等待 {room.players.find((p) => p.seat === room.turnSeat)?.name ?? '玩家'}…</span>}<span>第 {room.handNo} 局 · {compareUnlocked ? '可比牌' : '首轮行动中'}</span></div>
        {myTurn && <div className="action-grid">
          {!me.looked && <button disabled={busy} className="look" onClick={() => act({ type: 'look' })}>看牌</button>}
          <button disabled={busy} className="fold" onClick={() => act({ type: 'fold' })}>弃牌</button>
          {canAllIn ? <button className="all-in primary" disabled={busy} onClick={() => act({ type: 'all_in' })}>梭哈 {fmt(me.chips)}</button> : <button className="call primary" disabled={busy || me.chips < callCost} onClick={() => act({ type: 'call' })}>跟注 {fmt(callCost)}</button>}
          <div className="raise-box"><select disabled={busy} value={raiseUnit ?? ''} onChange={(e) => setRaiseUnit(Number(e.target.value))}>{room.settings.betOptions.filter((x) => x > room.betUnit).map((x) => <option key={x} value={x}>{fmt(x)}</option>)}</select><button disabled={busy || !raiseUnit || me.chips <= (raiseUnit ?? 0) * (me.looked ? 2 : 1)} onClick={() => raiseUnit && act({ type: 'raise', unit: raiseUnit })}>加注</button></div>
        </div>}
        {myTurn && compareUnlocked && <div className="compare-row"><span>比牌需 {fmt(comparePrice)}：</span>{room.players.filter((p) => p.id !== me.id && p.status === 'active').map((p) => <button disabled={busy || !canCompare} key={p.id} onClick={() => act({ type: 'compare', targetId: p.id })}>{p.name}</button>)}</div>}
        {isHost && <div className="rescue-row"><span>好友掉线卡桌时：</span>{room.players.filter((p) => !p.isBot && p.id !== me.id && p.status === 'active').map((p) => <button disabled={busy} key={p.id} onClick={() => window.confirm(`确认替 ${p.name} 弃牌并移出本局？`) && act({ type: 'remove_player', targetId: p.id })}>代弃 {p.name}</button>)}</div>}
        {myTurn && me.looked && me.hand.length === 3 && <div className="my-hand-large">{me.hand.map((c, i) => <CardView key={i} card={c} />)}</div>}
      </>}

      {room.phase === 'round_end' && <div className="result-panel"><p>本局赢家</p><h2>{room.result?.winnerName}</h2><strong>+{fmt(room.result?.potWon ?? 0)} 积分</strong><span>{room.result?.reason}</span>{isHost ? <button className="primary" onClick={() => act({ type: 'new_round' })}>准备下一局</button> : <small>等待房主开启下一局</small>}</div>}
      {error && <p className="error floating-error">{error}</p>}
    </section>

    <aside className="history"><h3>牌桌记录</h3>{room.log.slice(-9).reverse().map((x) => <div key={x.seq}><span>#{x.seq}</span><p>{x.text}</p></div>)}</aside>
    {toast && <div className="toast">{toast}</div>}
    <footer>仅供好友娱乐 · 虚拟积分不可充值、转让、提现或兑换任何现实价值</footer>
  </main>;
}
