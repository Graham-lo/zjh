import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isSameCard, type SjCard } from '../../shared/sj/cards.ts';
import { PlayingCard } from '../components/Card.tsx';

const reduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 底部手牌扇（DESIGN 3.3 / 3.4）。
 *
 * 25 张牌不可能等宽排开，所以间距是**算**出来的：量一次容器和牌宽，
 * 把 step 夹在「牌宽的 26%–62%」之间，宽屏摊开、窄屏收紧，永远不出容器。
 * 排序变化（发完牌、亮主定下主花色之后重排）走 FLIP：先记下每张牌的旧位置，
 * DOM 更新后用 Web Animations 从旧位置滑回来，带一点 spring 过冲。
 *
 * ## 为什么每张牌是三层 DOM
 *
 * 牌之间是**负边距大幅重叠**的，每张真正露在外面的只有左边一条窄边 ——
 * 命中区一旦跟着动效上下跑，指针就会在「抬起→离开→落下→再进入」之间抖起来，
 * 想点的那张牌从指针底下跑掉。所以这里立了一条硬规矩：
 * **`<button>`（＝命中区）的几何永远不变，只有它里面的视觉层在动。**
 *
 *   button.sj-hand-card       扇形的静态位置 + 命中区（顶部留出抬起量的 padding）
 *   span.sj-hand-card-flip    只给 FLIP 重排用（Web Animations 独占 transform）
 *   span.sj-hand-card-lift    选中抬起 / 发牌落桌，只有它会因交互改变 transform
 *
 * 分三层还有一个原因：FLIP 用 Web Animations 写 transform 会**整条覆盖**元素的
 * transform，和扇形/抬起写在同一层就会互相抢，重排那 600ms 里扇形会塌掉。
 */
export function Hand({
  cards,
  selected,
  hinted,
  onToggle,
  onSelectMany,
  pickForCard,
  rows = 1,
  disabled,
  lifted,
  hidden,
}: {
  cards: SjCard[];
  selected: Set<string>;
  /** 建议出的那一手，金色描边（不点「提示」也知道该往哪儿选） */
  hinted?: Set<string>;
  /** 整组切换：组里还有没选中的就补齐，全选中了才整组取消 */
  onToggle(ids: string[]): void;
  onSelectMany(ids: string[]): void;
  /** 单击一张牌时，由牌桌规则层决定要不要扩成对子、连对或一手完整跟牌 */
  pickForCard?(card: SjCard): string[];
  rows?: 1 | 2;
  disabled?: boolean;
  /** 轮到我时整手牌轻微上浮 6px */
  lifted?: boolean;
  /**
   * 还在半空中、暂时不该出现在扇子里的牌（扣底那 8 张）。
   * 飞完把它们放出来，FLIP 就顺势把整手牌重排一遍 —— 25→33 不会瞬间变多。
   */
  hidden?: Set<string>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(32);
  const prev = useRef(new Map<string, number>());
  const dragging = useRef(false);

  /* 间距自适应：容器一变宽、牌一变多就重算 */
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const card = wrap.querySelector<HTMLElement>('.sj-hand-card');
      const cw = card?.offsetWidth || 62;
      const perRow = Math.ceil((cards.length - (hidden?.size ?? 0)) / rows) || 1;
      const avail = wrap.clientWidth - 16;
      const raw = perRow > 1 ? (avail - cw) / (perRow - 1) : cw;
      setStep(Math.round(Math.min(cw * 0.62, Math.max(cw * 0.26, raw))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [cards.length, rows, hidden?.size]);

  /* FLIP：排序变了就从旧位置滑回来。量的是按钮，动的是它里面的 flip 层 */
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const nodes = [...wrap.querySelectorAll<HTMLElement>('.sj-hand-card')];
    const next = new Map<string, number>();
    for (const n of nodes) next.set(n.dataset.cid!, n.getBoundingClientRect().left);
    if (!reduced()) {
      for (const n of nodes) {
        const id = n.dataset.cid!;
        const from = prev.current.get(id);
        const to = next.get(id)!;
        if (from == null || Math.abs(from - to) < 1.5) continue;
        const layer = n.querySelector<HTMLElement>('.sj-hand-card-flip');
        layer?.animate(
          [{ transform: `translateX(${from - to}px)` }, { transform: 'translateX(0)' }],
          { duration: 600, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
    }
    prev.current = next;
  });

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  /** 两副牌，同一张牌最多两份，所以「对子」就是找那唯一的另一份 */
  const twinOf = (c: SjCard) => cards.find((x) => x.id !== c.id && isSameCard(x, c));

  const shown = hidden?.size ? cards.filter((c) => !hidden.has(c.id)) : cards;
  const chunks: SjCard[][] = [];
  const perRow = Math.ceil(shown.length / rows) || 1;
  for (let i = 0; i < shown.length; i += perRow) chunks.push(shown.slice(i, i + perRow));
  if (!chunks.length) chunks.push([]);

  return (
    <div className={`sj-hand${lifted ? ' is-turn' : ''}${disabled ? ' is-off' : ''}`} ref={wrapRef}>
      {chunks.map((row, r) => (
        <div className="sj-hand-row" key={r} style={{ ['--step' as string]: `${step}px` }}>
          {row.map((c, i) => {
            // 扇形：中间略高、两端略低，角度也跟着走一点，别排成一条直尺
            const t = row.length > 1 ? (i / (row.length - 1)) * 2 - 1 : 0;
            const on = selected.has(c.id);
            return (
              <button
                key={c.id}
                data-cid={c.id}
                className={`sj-hand-card${on ? ' on' : ''}${hinted?.has(c.id) ? ' hint' : ''}`}
                style={{
                  ['--i' as string]: i,
                  ['--rot' as string]: `${(t * 3.2).toFixed(2)}deg`,
                  ['--dy' as string]: `${(-(1 - t * t) * 6).toFixed(1)}px`,
                }}
                disabled={disabled}
                aria-pressed={on}
                onPointerDown={() => {
                  dragging.current = true;
                }}
                onPointerEnter={() => {
                  // 按住横扫多选（手机上一次点一张太慢了）
                  if (dragging.current && !selected.has(c.id)) onSelectMany([c.id]);
                }}
                onClick={() => {
                  const ids = pickForCard?.(c) ?? [c.id];
                  onToggle(ids.length ? ids : [c.id]);
                }}
                onDoubleClick={() => {
                  // 双击自动带上它的对子（首出是单张时，这是唯一的成对选法）
                  const twin = twinOf(c);
                  if (twin) onSelectMany([c.id, twin.id]);
                }}
              >
                <span className="sj-hand-card-flip">
                  <span className="sj-hand-card-lift">
                    <PlayingCard card={c} faceDown={false} size="hand" />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
