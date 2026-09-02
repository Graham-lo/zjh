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
 */
export function Hand({
  cards,
  selected,
  hinted,
  onToggle,
  onSelectMany,
  rows = 1,
  disabled,
  lifted,
}: {
  cards: SjCard[];
  selected: Set<string>;
  /** 「提示」给出的候选，金色描边 */
  hinted?: Set<string>;
  onToggle(id: string): void;
  onSelectMany(ids: string[]): void;
  rows?: 1 | 2;
  disabled?: boolean;
  /** 轮到我时整手牌轻微上浮 6px */
  lifted?: boolean;
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
      const perRow = Math.ceil(cards.length / rows) || 1;
      const avail = wrap.clientWidth - 16;
      const raw = perRow > 1 ? (avail - cw) / (perRow - 1) : cw;
      setStep(Math.round(Math.min(cw * 0.62, Math.max(cw * 0.26, raw))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [cards.length, rows]);

  /* FLIP：排序变了就从旧位置滑回来 */
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
        n.animate(
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

  const chunks: SjCard[][] = [];
  const perRow = Math.ceil(cards.length / rows) || 1;
  for (let i = 0; i < cards.length; i += perRow) chunks.push(cards.slice(i, i + perRow));
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
                onClick={() => onToggle(c.id)}
                onDoubleClick={() => {
                  // 双击自动带上它的对子
                  const twin = cards.find((x) => x.id !== c.id && isSameCard(x, c));
                  if (twin) onSelectMany([c.id, twin.id]);
                }}
              >
                <PlayingCard card={c} faceDown={false} size="hand" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
