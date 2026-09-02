import { useEffect, useRef, useState } from 'react';
import { AVATARS } from '../shared/game.ts';
import type { GameKind } from '../shared/games.ts';
import type { AccountInfo, AnyGameCommand, AnyPublicRoom, GameEvent } from '../shared/protocol.ts';
import { Landing, type Identity } from './components/Landing.tsx';
import { Net, type Auth, type NetStatus } from './net.ts';
import { sound, voice } from './sound.ts';
import { Table } from './table.tsx';

const IDENT_KEY = 'zjh:me';
// 账户凭证和房间无关：换房间、隔天再来都还是同一个自己，积分接着上次
const ACCOUNT_KEY = 'zjh:account';
const authKey = (code: string) => `zjh:auth:${code}`;

function loadIdent(): Identity {
  try {
    const raw = localStorage.getItem(IDENT_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Identity>;
      if (v.name) return { name: String(v.name).slice(0, 10), avatar: AVATARS.includes(v.avatar ?? '') ? v.avatar! : AVATARS[0] };
    }
  } catch {
    /* 隐私模式：用随机身份即可 */
  }
  return {
    name: `牌友${1000 + Math.floor(Math.random() * 9000)}`,
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
  };
}

function loadAccount(): { id: string; token: string } | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id: string; token: string };
    return v.id && v.token ? v : null;
  } catch {
    return null;
  }
}

function loadAuth(code: string): Auth | null {
  try {
    const raw = localStorage.getItem(authKey(code));
    if (!raw) return null;
    const v = JSON.parse(raw) as Auth;
    return v.playerId && v.token ? { ...v, code } : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [status, setStatus] = useState<NetStatus>('connecting');
  const [room, setRoom] = useState<AnyPublicRoom | null>(null);
  const [ident, setIdentState] = useState<Identity>(loadIdent);
  useEffect(() => {
    // 第一次进来是随机分配的昵称，也要落盘，否则下次刷新又换了个人
    try {
      if (!localStorage.getItem(IDENT_KEY)) localStorage.setItem(IDENT_KEY, JSON.stringify(ident));
    } catch {
      /* ignore */
    }
  }, []);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [latency, setLatency] = useState(0);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<{ seq: number; events: GameEvent[] }>({ seq: 0, events: [] });
  const [account, setAccount] = useState<AccountInfo | null>(null);

  const netRef = useRef<Net | null>(null);
  const seqRef = useRef(0);
  const toastTimer = useRef(0);
  const initialCode = useRef(
    (new URLSearchParams(location.search).get('room') ?? '').replace(/\D/g, '').slice(0, 6),
  ).current;

  const notify = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  };

  const setIdent = (next: Identity) => {
    setIdentState(next);
    try {
      localStorage.setItem(IDENT_KEY, JSON.stringify(next));
    } catch {
      /* 存不下也不影响这一局 */
    }
  };

  useEffect(() => {
    const net = new Net({
      onStatus: setStatus,
      onWelcome: (auth, r) => {
        try {
          localStorage.setItem(authKey(auth.code), JSON.stringify({ playerId: auth.playerId, token: auth.token }));
        } catch {
          /* 无痕模式下刷新会丢座位，但当前这局照常 */
        }
        setBusy(false);
        setError('');
        setRoom(r);
        if (new URLSearchParams(location.search).get('room') !== auth.code) {
          history.replaceState(null, '', `?room=${auth.code}`);
        }
      },
      onRoom: (r, events) => {
        setRoom(r);
        if (events.length) {
          seqRef.current += 1;
          setBatch({ seq: seqRef.current, events });
        }
      },
      onError: (msg, fatal) => {
        setBusy(false);
        if (fatal) {
          const code = new URLSearchParams(location.search).get('room') ?? '';
          if (code) {
            try {
              localStorage.removeItem(authKey(code));
            } catch {
              /* ignore */
            }
          }
          setRoom(null);
          setError(msg);
          history.replaceState(null, '', location.pathname);
        } else {
          notify(msg);
        }
      },
      onAccount: (acc: AccountInfo) => {
        try {
          localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ id: acc.id, token: acc.token }));
        } catch {
          /* 无痕模式下每次都是新账户，只能这样 */
        }
        setAccount(acc);
      },
      onLatency: setLatency,
    });
    netRef.current = net;
    if (/^\d{6}$/.test(initialCode)) net.resume = loadAuth(initialCode);
    net.start();
    return () => net.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cmd = (c: AnyGameCommand) => {
    const net = netRef.current;
    if (!net || !room) return;
    sound.unlock();
    voice.unlock();
    if (c.type === 'leave') {
      try {
        localStorage.removeItem(authKey(room.code));
      } catch {
        /* ignore */
      }
      net.cmd(c);
      net.resume = null;
      setRoom(null);
      history.replaceState(null, '', location.pathname);
      return;
    }
    net.cmd(c);
  };

  const enter = (how: 'create' | 'join', code = '', kind: GameKind = 'zjh') => {
    const net = netRef.current;
    if (!net) return;
    sound.unlock();
    voice.unlock();
    setBusy(true);
    setError('');
    const acc = loadAccount();
    const hello = { name: ident.name, avatar: ident.avatar, accountId: acc?.id, accountToken: acc?.token };
    net.send(how === 'create' ? { t: 'create', kind, ...hello } : { t: 'join', code, ...hello });
    // 网络卡住时不要让按钮一直转
    setTimeout(() => setBusy(false), 6000);
  };

  return (
    <>
      {room ? (
        room.kind === 'zjh' ? (
          <Table room={room} cmd={cmd} status={status} latency={latency} batch={batch} onToast={notify} account={account} />
        ) : (
          <div className="loading">升级牌桌加载中…</div>
        )
      ) : (
        <Landing
          ident={ident}
          onIdent={setIdent}
          initialCode={initialCode}
          busy={busy}
          status={status}
          error={error}
          onCreate={(kind) => enter('create', '', kind)}
          onJoin={(code) => enter('join', code)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
