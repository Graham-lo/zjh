import { useEffect, useRef, useState } from 'react';
import { AVATARS } from '../../shared/game.ts';
import { GAME_META, SJ_VARIANTS, type GameKind } from '../../shared/games.ts';
import type { NetStatus } from '../net.ts';
import { PlayingCard } from './Card.tsx';

export interface Identity {
  name: string;
  avatar: string;
}

/** 炸金花的牌型阶梯：越靠前越稀有，配色也跟着从实金退到灰 */
const ZJH_LADDER = ['豹子', '顺金', '金花', '顺子', '对子', '散牌'];

/** 打通关的级牌阶梯：2 → A，当前高亮第一格 */
const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankText = (n: number) => RANK_LABEL[n] ?? String(n);

/**
 * 首页那三张悬浮的牌。A♠ 亮面 + 5♥（升级的第一张级牌）+ 一张牌背，
 * 一眼把两种游戏都点到，第三张留背面，暗示「还有一张没揭晓」。
 */
const HERO = [
  { card: { suit: 'S', rank: 14 } as const, down: false },
  { card: { suit: 'H', rank: 5 } as const, down: false },
  { card: undefined, down: true },
];

const KIND_KEY = 'zjh:kind';

/** 桌卡的绒布色，和进入后牌桌的底色是同一个 —— 从首页到牌桌颜色连续（DESIGN 3.1） */
const TINT: Record<GameKind, string> = {
  zjh: '20, 112, 73',
  sj_510k: '20, 41, 74',
  sj_2a: '20, 41, 74',
};

const SUBTITLE: Record<GameKind, string> = {
  zjh: 'ZHA JIN HUA',
  sj_510k: 'SHENG JI · 5 10 K',
  sj_2a: 'SHENG JI · 2 → A',
};

const BLURB: Record<GameKind, string> = {
  zjh: '三张牌定输赢。看牌翻倍、随时弃、梭哈要有人接。',
  sj_510k: '两副牌，四人对家。打 5、打 10、打 K —— 三级定胜负。',
  sj_2a: '从 2 一路打到 A，打过 A 才算赢。一整晚的长局。',
};

const TAGS: Record<GameKind, string[]> = {
  zjh: ['2–6 人', '一副牌', '积分'],
  sj_510k: ['4 人 · 两队', '两副牌', '80 分上台'],
  sj_2a: ['4 人 · 两队', '两副牌', '80 分上台'],
};

const KINDS: GameKind[] = ['zjh', 'sj_510k', 'sj_2a'];

function loadKind(): GameKind {
  try {
    const v = localStorage.getItem(KIND_KEY);
    if (v && (KINDS as string[]).includes(v)) return v as GameKind;
  } catch {
    /* 隐私模式：用默认值 */
  }
  return 'sj_510k';
}

/** 一条金色丝带阶梯，复用炸金花首页那条 `.ladder` 的成色递退 */
function Ribbon({ items, variant = '' }: { items: string[]; variant?: string }) {
  return (
    <div className={`ladder${variant ? ` ${variant}` : ''}`}>
      {items.map((r, i) => (
        <span key={r + i} className={i === 0 ? 'top' : ''} style={{ ['--k' as string]: Math.min(i, 5) }}>
          {r}
        </span>
      ))}
    </div>
  );
}

/** 五十K 的三枚级牌卡：5 → 10 → K，当前那张是真牌面，后面两张是描金空位 */
function LevelCards({ ladder }: { ladder: number[] }) {
  return (
    <div className="lvl-row">
      {ladder.map((n, i) => (
        <span key={n} className="lvl-step">
          {i > 0 && <i className="lvl-arrow">→</i>}
          <b className={`lvl-card${i === 0 ? ' on' : ''}`}>{rankText(n)}</b>
        </span>
      ))}
    </div>
  );
}

function TableCard({
  kind,
  selected,
  onSelect,
  onOpen,
  busy,
}: {
  kind: GameKind;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
  busy: boolean;
}) {
  const meta = GAME_META[kind];
  return (
    <div
      className={`tcard${selected ? ' on' : ''}`}
      style={{ ['--tint' as string]: TINT[kind] }}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="hairline top" aria-hidden="true" />
      <div className="tcard-main">
        <div className="tcard-head">
          <b>{meta.label}</b>
          <span>{SUBTITLE[kind]}</span>
        </div>
        <p className="tcard-blurb">{BLURB[kind]}</p>
        <div className="tcard-tags">
          {TAGS[kind].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="tcard-ladder">
          {kind === 'zjh' && <Ribbon items={ZJH_LADDER} />}
          {kind === 'sj_510k' && <LevelCards ladder={[...SJ_VARIANTS.sj_510k.ladder]} />}
          {kind === 'sj_2a' && (
            <>
              <Ribbon variant="long" items={SJ_VARIANTS.sj_2a.ladder.map(rankText)} />
              <Ribbon variant="short" items={['2', '3', '…', 'K', 'A']} />
            </>
          )}
        </div>
      </div>
      <button
        className={`btn ${selected ? 'primary' : 'tier'} tcard-go`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          onOpen();
        }}
      >
        开一桌
      </button>
    </div>
  );
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
  onCreate(kind: GameKind): void;
  onJoin(code: string): void;
}) {
  const [code, setCode] = useState(initialCode);
  const [invite, setInvite] = useState(!!initialCode);
  const [kind, setKind] = useState<GameKind>(loadKind);
  const codeRef = useRef<HTMLInputElement>(null);
  const ready = status === 'online' && ident.name.trim().length > 0;

  const pick = (next: GameKind) => {
    setKind(next);
    try {
      localStorage.setItem(KIND_KEY, next);
    } catch {
      /* 存不下也不影响这一次 */
    }
  };

  // 三张牌依次翻入：一进门就先看一遍「牌是会翻的」，
  // 后面牌桌上真的翻牌时就不需要再教一次。
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = HERO.map((_, i) => setTimeout(() => setShown((n) => Math.max(n, i + 1)), 380 + i * 190));
    return () => t.forEach(clearTimeout);
  }, []);

  return (
    <main className="landing home" data-tint={kind === 'zjh' ? 'zjh' : 'sj'}>
      {/* 环境：两枚巨大的花色水印，把空白撑成一间有纵深的牌室 */}
      <span className="watermark wm-a" aria-hidden="true">
        ♠
      </span>
      <span className="watermark wm-b" aria-hidden="true">
        ♦
      </span>
      <div className="hairline top" aria-hidden="true" />

      <section className="brand home-brand">
        <div className="brand-mark" aria-hidden="true">
          <span>♠</span>
        </div>
        <p className="eyebrow">私 人 牌 会 · FRIENDS ONLY</p>
        <h1>牌 会</h1>
        <p className="lead">
          三张桌子，一个房间号。发一条链接，好友落座即开局 —— 炸金花的一把梭，升级的一场翻盘，都值得一点仪式感。
        </p>

        <div className="hero-cards" aria-hidden="true">
          {HERO.map((h, i) => (
            <span className="hero-slot" key={i} style={{ ['--i' as string]: i }}>
              <PlayingCard card={h.card} faceDown={h.down || shown <= i} size="big" dealIndex={i} />
            </span>
          ))}
        </div>
      </section>

      <section className="home-tables" role="radiogroup" aria-label="选一张桌子">
        {KINDS.map((k) => (
          <TableCard
            key={k}
            kind={k}
            selected={kind === k}
            busy={!ready || busy}
            onSelect={() => pick(k)}
            onOpen={() => onCreate(k)}
          />
        ))}
      </section>

      <section className="entry home-entry">
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
            <button className="btn ghost" disabled={!ready || busy} onClick={() => onCreate(kind)}>
              不加入，自己开一桌 · {GAME_META[kind].label}
            </button>
          </>
        ) : (
          <>
            {/* 主按钮跟着选中的桌走 —— 选桌和开桌是同一件事的两半 */}
            <button className="btn primary lg" disabled={!ready || busy} onClick={() => onCreate(kind)}>
              开一桌 · {GAME_META[kind].label}
            </button>
            <div className="divider">
              <span>或凭房号加入任意一桌</span>
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
            {/* 加入房间不用选游戏：房号决定一切（DESIGN 3.1） */}
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
