/**
 * 全屏高潮特效。
 *
 * 每个特效都按「蓄力 → 冲击 → 收束」三拍编排：不给蓄力，冲击就没有分量；
 * 不给收束，情绪会断在半空。节拍由这里的 setTimeout 推进，具体的位移、
 * 光影和粒子全部交给 CSS（styles.css 的「特效」一节），
 * 这样常驻循环不占 JS，也能被 prefers-reduced-motion 一次性关掉。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Card } from '../../shared/game.ts';
import { PlayingCard } from './Card.tsx';

/* ------------------------------------------------------------- 立体筹码 */

/**
 * CSS 画的筹码圆片。用 DOM 而不是一个「+100」文字标签，
 * 是因为钱要有体积：飞过去的是三枚会自旋的圆片，不是一行字。
 * 面额只决定枚数（1/2/3），不写在筹码上 —— 底池数字已经在滚动了。
 */
export function ChipStack({ count }: { count: number }) {
  return (
    <span className="chip-stack">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className="chip" style={{ ['--c' as string]: i }} />
      ))}
    </span>
  );
}

/* --------------------------------------------------------------- 梭哈 */

export type ShoveBeat = 'charge' | 'impact' | 'settle';

/**
 * 梭哈：全场最大的一下。
 * 蓄力 500ms 全桌调暗、发起者座位金光聚拢；冲击 700ms「梭 哈」从 3.2 倍
 * 带模糊砸落 + 冲击波圆环 + 金色粒子喷泉 + 震屏；之后余韵交给牌桌
 * （底池火焰橙呼吸、表态条心跳）常驻到本局结束。
 */
export function ShoveFx({ who, amount, onDone }: { who: string; amount: number; onDone(): void }) {
  const [beat, setBeat] = useState<ShoveBeat>('charge');
  useEffect(() => {
    const a = setTimeout(() => setBeat('impact'), 500);
    const b = setTimeout(() => setBeat('settle'), 1200);
    const c = setTimeout(onDone, 1700);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
      clearTimeout(c);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`overlay shove-fx beat-${beat}`} aria-hidden="true">
      <div className="shove-wave" />
      <div className="shove-ring r1" />
      <div className="shove-ring r2" />
      <Particles count={18} className="shove-spark" />
      <div className="shove-core">
        <div className="shove-word">梭 哈</div>
        <div className="shove-who">
          {who} 推入 {amount.toLocaleString('zh-CN')}
        </div>
      </div>
      <div className="overlay-vignette" />
    </div>
  );
}

/* ------------------------------------------------------------ 比牌对决 */

export interface DuelSide {
  name: string;
  avatar: string;
  /** 有权看到就传真牌，旁观者传空数组 —— 揭晓时会退回牌背 */
  hand: Card[];
  won: boolean;
}

type DuelBeat = 'charge' | 'clash' | 'hold' | 'reveal';

/**
 * 比牌：金 vs 蓝的三拍对决。
 *
 * 拍一 蓄力 600ms：全桌压暗，两束追光劈向双方，牌扇后仰蓄势。
 * 拍二 对撞 400ms：两副暗牌斜向冲进中央，闪白裂隙 +「比」字金蓝双色撕裂砸下 + 火花。
 * 拍三 定帧 300ms 后揭晓 900ms：胜者破光翻开、金边辉光，败者碎裂成暗色残片坠落。
 *
 * 冷钢蓝只在这一刻出现 —— 平时整张桌子都是金的，蓝一亮就知道有人要出局了。
 */
export function CompareDuel({
  left,
  right,
  onDone,
}: {
  left: DuelSide;
  right: DuelSide;
  onDone(): void;
}) {
  const [beat, setBeat] = useState<DuelBeat>('charge');
  useEffect(() => {
    const t = [
      setTimeout(() => setBeat('clash'), 600),
      setTimeout(() => setBeat('hold'), 1000),
      setTimeout(() => setBeat('reveal'), 1300),
      setTimeout(onDone, 2300),
    ];
    return () => t.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revealing = beat === 'reveal';
  const side = (s: DuelSide, which: 'a' | 'b') => (
    <div className={`duel-side duel-${which}${s.won ? ' is-win' : ' is-lose'}`}>
      <div className="duel-who">
        <span className="duel-av">{s.avatar}</span>
        <b>{s.name}</b>
        <i>{which === 'a' ? '发起比牌' : '被比牌'}</i>
      </div>
      <div className="duel-fan">
        {[0, 1, 2].map((i) => (
          <span className="duel-card" style={{ ['--i' as string]: i }} key={i}>
            <PlayingCard
              card={revealing ? s.hand[i] : undefined}
              faceDown={!revealing || s.hand.length !== 3}
              size="big"
              tone={revealing ? (s.won ? 'win' : 'shard') : undefined}
            />
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`overlay duel beat-${beat}`} aria-hidden="true">
      <div className="duel-beam gold" />
      <div className="duel-beam steel" />
      <div className="duel-speed" />
      {side(left, 'a')}
      {side(right, 'b')}
      <div className="duel-rift" />
      <div className="duel-flash" />
      <Particles count={12} className="duel-spark" />
      <div className="duel-stamp">
        <span className="s gold">比</span>
        <span className="s steel">比</span>
        <span className="s core">比</span>
      </div>
      <div className="duel-banner">
        {left.won ? left.name : right.name} 胜 · {left.won ? right.name : left.name} 出局
      </div>
      <div className="overlay-vignette" />
    </div>
  );
}

/* --------------------------------------------------------------- 粒子 */

/**
 * 一把飞散的粒子。角度和距离用下标算死，不用 Math.random ——
 * 同一个特效每次看到的形状一致，才像是一件设计过的东西而不是噪声。
 */
export function Particles({ count, className }: { count: number; className: string }) {
  const items = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + (i % 3) * 0.21;
        const dist = 150 + ((i * 37) % 190);
        return {
          x: `${(Math.cos(angle) * dist).toFixed(0)}px`,
          y: `${(Math.sin(angle) * dist * 0.72 - 40).toFixed(0)}px`,
          d: `${(i % 5) * 46}ms`,
          s: 0.6 + ((i * 13) % 9) / 10,
        };
      }),
    [count],
  );
  return (
    <>
      {items.map((p, i) => (
        <i
          key={i}
          className={className}
          style={{
            ['--px' as string]: p.x,
            ['--py' as string]: p.y,
            ['--pd' as string]: p.d,
            ['--ps' as string]: p.s,
          }}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------- 金雨 */

/** 自己赢了才会下的一场金雨。纯 CSS 循环，落完就卸载。 */
export function GoldRain() {
  const drops = useMemo(
    () =>
      Array.from({ length: 34 }, (_, i) => ({
        left: `${(i * 97) % 100}%`,
        delay: `${(i % 11) * 90}ms`,
        dur: `${1500 + ((i * 53) % 900)}ms`,
        scale: 0.55 + ((i * 17) % 10) / 12,
      })),
    [],
  );
  return (
    <div className="gold-rain" aria-hidden="true">
      {drops.map((d, i) => (
        <i
          key={i}
          style={{
            left: d.left,
            ['--rd' as string]: d.delay,
            ['--rt' as string]: d.dur,
            ['--rs' as string]: d.scale,
          }}
        />
      ))}
    </div>
  );
}
