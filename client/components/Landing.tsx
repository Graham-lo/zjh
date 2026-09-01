import { useRef, useState } from 'react';
import { AVATARS } from '../../shared/game.ts';
import type { NetStatus } from '../net.ts';

export interface Identity {
  name: string;
  avatar: string;
}

export function Landing({
  ident,
  onIdent,
  initialCode,
  busy,
  status,
  error,
  onCreate,
  onJoin,
}: {
  ident: Identity;
  onIdent(next: Identity): void;
  initialCode: string;
  busy: boolean;
  status: NetStatus;
  error: string;
  onCreate(): void;
  onJoin(code: string): void;
}) {
  const [code, setCode] = useState(initialCode);
  const [invite, setInvite] = useState(!!initialCode);
  const codeRef = useRef<HTMLInputElement>(null);
  const ready = status === 'online' && ident.name.trim().length > 0;

  return (
    <main className="landing">
      <section className="brand">
        <div className="brand-mark" aria-hidden="true">
          ♠
        </div>
        <p className="eyebrow">FRIENDS TABLE</p>
        <h1>好友炸金花</h1>
        <p className="lead">2–6 人私人牌桌。开房、发链接、坐下就打。虚拟积分仅供娱乐，不充值、不转让、不提现、不兑换。</p>
        <div className="rules-strip">
          {['豹子', '同花顺', '同花', '顺子', '对子', '单张'].map((r, i) => (
            <span key={r}>
              {i > 0 && <i>›</i>}
              {r}
            </span>
          ))}
        </div>
      </section>

      <section className="entry">
        <h2>{invite ? '加入好友的房间' : '进入牌桌'}</h2>

        <label className="field-label">选个头像</label>
        <div className="avatar-grid" role="radiogroup" aria-label="选择头像">
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={ident.avatar === a}
              className={`avatar-opt${ident.avatar === a ? ' on' : ''}`}
              onClick={() => onIdent({ ...ident, avatar: a })}
            >
              {a}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="nick">
          你的昵称
        </label>
        <input
          id="nick"
          className="text-input"
          value={ident.name}
          maxLength={10}
          placeholder="让朋友一眼认出你"
          onChange={(e) => onIdent({ ...ident, name: e.target.value })}
        />

        {invite ? (
          <>
            <div className="invite-target">
              <span>受邀房间</span>
              <strong>{initialCode}</strong>
            </div>
            <button className="btn primary lg" disabled={!ready || busy} onClick={() => onJoin(initialCode)}>
              加入房间 {initialCode}
            </button>
            <button className="btn ghost" disabled={!ready || busy} onClick={onCreate}>
              不加入，自己开一桌
            </button>
          </>
        ) : (
          <>
            <button className="btn primary lg" disabled={!ready || busy} onClick={onCreate}>
              创建私人房间
            </button>
            <div className="divider">
              <span>或加入好友</span>
            </div>
            <div className="code-input" onClick={() => codeRef.current?.focus()}>
              <input
                ref={codeRef}
                className="code-real"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                aria-label="6 位房间号"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={`code-cell${code.length === i ? ' caret' : ''}`}>
                  {code[i] ?? ''}
                </span>
              ))}
            </div>
            <button className="btn ghost" disabled={!ready || busy || code.length !== 6} onClick={() => onJoin(code)}>
              加入房间
            </button>
          </>
        )}

        {invite && (
          <button className="link-btn" onClick={() => setInvite(false)}>
            输入别的房间号
          </button>
        )}
        {status !== 'online' && <p className="hint">{status === 'connecting' ? '正在连接服务器…' : '连接断开，正在重连…'}</p>}
        {error && <p className="error">{error}</p>}
        <p className="fineprint">纯娱乐积分游戏，不涉及任何现实金钱或可兑换价值。</p>
      </section>
    </main>
  );
}
