import { useEffect, useRef, useState } from 'react';
import { AVATARS } from '../../shared/game.ts';
import type { NetStatus } from '../net.ts';
import { PlayingCard } from './Card.tsx';

export interface Identity {
  name: string;
  avatar: string;
}

/** 牌型阶梯：越靠前越稀有，配色也跟着从实金退到灰 */
const LADDER = ['豹子', '顺金', '金花', '顺子', '对子', '散牌'];

/** 首页那三张悬浮的牌。A♠ 与 A♥ 亮面，第三张留牌背，暗示「还有一张没揭晓」 */
const HERO = [
  { card: { suit: 'S', rank: 14 } as const, down: false },
  { card: { suit: 'H', rank: 14 } as const, down: false },
  { card: undefined, down: true },
];

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

  // 三张牌依次翻入：一进门就先看一遍「牌是会翻的」，
  // 后面牌桌上真的翻牌时就不需要再教一次。
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = HERO.map((_, i) => setTimeout(() => setShown((n) => Math.max(n, i + 1)), 380 + i * 190));
    return () => t.forEach(clearTimeout);
  }, []);

  return (
    <main className="landing">
      {/* 环境：两枚巨大的花色水印，把空白撑成一间有纵深的牌室 */}
      <span className="watermark wm-a" aria-hidden="true">
        ♠
      </span>
      <span className="watermark wm-b" aria-hidden="true">
        ♦
      </span>
      <div className="hairline top" aria-hidden="true" />

      <section className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span>♠</span>
        </div>
        <p className="eyebrow">私 人 牌 会 · FRIENDS ONLY</p>
        <h1>好友炸金花</h1>
        <p className="lead">
          开一间只属于你们的房间。发一条链接，好友落座即开局 —— 每一次发牌、比牌与梭哈，都值得一点仪式感。
        </p>

        <div className="ladder">
          {LADDER.map((r, i) => (
            <span key={r} className={i === 0 ? 'top' : ''} style={{ ['--k' as string]: i }}>
              {r}
            </span>
          ))}
        </div>

        <div className="hero-cards" aria-hidden="true">
          {HERO.map((h, i) => (
            <span className="hero-slot" key={i} style={{ ['--i' as string]: i }}>
              <PlayingCard card={h.card} faceDown={h.down || shown <= i} size="big" dealIndex={i} />
            </span>
          ))}
        </div>
      </section>

      <section className="entry">
        <div className="hairline card" aria-hidden="true" />
        <h2>{invite ? '加入好友的房间' : '入座'}</h2>
        <p className="entry-sub">选个样子，让朋友一眼认出你</p>

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
          昵称
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
              <span>或凭房号加入</span>
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
                <span key={i} className={`code-cell${code.length === i ? ' caret' : ''}${code[i] ? ' filled' : ''}`}>
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
        <p className="fineprint">纯娱乐积分 · 不充值 · 不转让 · 不提现</p>
      </section>
    </main>
  );
}
