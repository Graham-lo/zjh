import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SjCard } from '../../shared/sj/cards.ts';
import { PlayingCard } from '../components/Card.tsx';
import { sweepModeOf } from './util.ts';

const reduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 按下之后走多远才算"拖"而不是"点" */
const SLOP = 6;
/** 连点同一张多久之内算双击 */
const DOUBLE_MS = 300;

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
 *   button.sj-hand-card       扇形的静态位置 + 命中区
 *   span.sj-hand-card-flip    只给 FLIP 重排用（Web Animations 独占 transform）
 *   span.sj-hand-card-lift    发牌落桌；选中态在它里面只加颜色，不改 transform
 *
 * 分三层还有一个原因：FLIP 用 Web Animations 写 transform 会**整条覆盖**元素的
 * transform，和扇形写在同一层就会互相抢，重排那 600ms 里扇形会塌掉。
 *
 * ## 选中态为什么不抬牌
 *
 * 扇子是左压右叠的，一张牌只露出左边一条窄条。把选中的牌抬起来（或者提 z-index）
 * 就等于让它的左邻盖住它唯一露出来的那条 —— 用户看到的正是「左右浮起来、中间那张
 * 反而看不见」。所以选中**只用颜色表达**：暖金蒙版 + 顶/左两条金线 + 左上角一枚 ✓，
 * 几何、层级、transform 一概不动。
 *
 * ## 指针交互全部挂在行容器上
 *
 * 逐张 `pointerenter` 在手机上根本不会来（触摸有隐式 pointer capture），而且只能加
 * 不能减。这里改成**按 x 的区间框选**：`pointerdown` 时记下锚点牌和当时的整份选中集，
 * 之后每次 `pointermove` 都用 `clientX` 对照缓存的各牌矩形算出扫过的区间，
 * 重新算一遍 `预览 = 初始 ∪ 扫过`（或 `初始 \ 扫过`）—— 往回拖就自动撤销，
 * 不会越拖越多。模式由锚点牌**按下时**的选中状态决定：没选中就是"选"，选中了就是"取消"。
 */
export function Hand({
  cards,
  selected,
  hinted,
  blamed,
  onPick,
  onPickUnit,
  onSweep,
  rows = 1,
  disabled,
  lifted,
  hidden,
  dealing,
}: {
  cards: SjCard[];
  selected: Set<string>;
  /** 建议出的那一手，淡蓝虚线内描边（不点「提示」也知道该往哪儿选） */
  hinted?: Set<string>;
  /** 这一手不合法时**该怪的那几张**（"有对子必须出对子"到底指哪几张），暖红虚线 */
  blamed?: Set<string>;
  /** 单击一张：只动这一张。要不要「被迫补齐」由牌桌规则层决定 */
  onPick(card: SjCard): void;
  /** 双击/300ms 内连点同一张：用户主动要整单位（最长拖拉机 > 对子） */
  onPickUnit(card: SjCard): void;
  /** 按住横扫：一次提交扫过的那一段，选或者取消 */
  onSweep(ids: string[], mode: 'add' | 'remove'): void;
  rows?: 1 | 2;
  disabled?: boolean;
  /** 轮到我时整手牌轻微上浮 6px（整体、均匀，不是单张） */
  lifted?: boolean;
  /**
   * 还在半空中、暂时不该出现在扇子里的牌（扣底那 8 张）。
   * 飞完把它们放出来，FLIP 就顺势把整手牌重排一遍 —— 25→33 不会瞬间变多。
   */
  hidden?: Set<string>;
  /**
   * 正在发牌：牌是一张张插进扇子里的，每插一张后面的牌都要让位。
   * 这时候 FLIP 用短促的滑动而不是 600ms 的 spring 过冲 —— 25 次弹簧叠在一起会晃得看不清。
   */
  dealing?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(32);
  const prev = useRef(new Map<string, number>());
  /** 拖动过程中的预览选中集；不为 null 时它就是画面上看到的那一份 */
  const [preview, setPreview] = useState<Set<string> | null>(null);
  const drag = useRef<{
    row: SjCard[];
    /** 按下时量好的各牌矩形，拖动过程中几何不会变，所以量一次就够 */
    lefts: number[];
    anchor: number;
    mode: 'add' | 'remove';
    base: Set<string>;
    x0: number;
    y0: number;
    pointerId: number;
  } | null>(null);
  const lastTap = useRef<{ id: string; t: number }>({ id: '', t: 0 });

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
          dealing
            ? { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
            : { duration: 600, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
    }
    prev.current = next;
  });

  const shown = hidden?.size ? cards.filter((c) => !hidden.has(c.id)) : cards;
  const chunks: SjCard[][] = [];
  const perRow = Math.ceil(shown.length / rows) || 1;
  for (let i = 0; i < shown.length; i += perRow) chunks.push(shown.slice(i, i + perRow));
  if (!chunks.length) chunks.push([]);

  /**
   * 指针落在这一行的第几张牌上。
   *
   * 扇子里第 i 张真正露在外面的是 `[left_i, left_{i+1})` 这一条，最后一张露到右边缘为止 ——
   * 所以命中判定只看 x，和 `pointerenter` 那套「谁在最上层」完全无关，
   * 手机上手指划过被上层牌挡住的部分也照样算命中。
   */
  const hitIndex = (lefts: number[], x: number) => {
    for (let i = 0; i < lefts.length - 1; i++) if (x < lefts[i + 1]) return i;
    return lefts.length - 1;
  };

  const previewOf = (base: Set<string>, ids: string[], mode: 'add' | 'remove') => {
    const next = new Set(base);
    for (const id of ids) if (mode === 'add') next.add(id); else next.delete(id);
    return next;
  };

  const endDrag = () => {
    drag.current = null;
    setPreview(null);
  };

  const rowHandlers = (row: SjCard[]) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || drag.current || !row.length) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const host = e.currentTarget;
      const lefts = [...host.querySelectorAll<HTMLElement>('.sj-hand-card')]
        .map((n) => n.getBoundingClientRect().left);
      if (lefts.length !== row.length) return;
      const anchor = hitIndex(lefts, e.clientX);
      const card = row[anchor];
      if (!card) return;
      const mode = sweepModeOf(selected, card.id);
      const base = new Set(selected);
      drag.current = { row, lefts, anchor, mode, base, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId };
      // 捕获到行容器上：之后所有 move/up 都来这里，手指划出按钮也不会断
      try { host.setPointerCapture(e.pointerId); } catch { /* 捕获不上就退回冒泡，行为一样 */ }
      setPreview(previewOf(base, [card.id], mode));
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const hit = hitIndex(d.lefts, e.clientX);
      const lo = Math.min(d.anchor, hit);
      const hi = Math.max(d.anchor, hit);
      setPreview(previewOf(d.base, d.row.slice(lo, hi + 1).map((c) => c.id), d.mode));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      endDrag();
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已经放掉了 */ }
      const hit = hitIndex(d.lefts, e.clientX);
      const far = Math.hypot(e.clientX - d.x0, e.clientY - d.y0) >= SLOP;
      if (!far && hit === d.anchor) {
        // 没挪动也没离开锚点牌 = 单击
        const card = d.row[d.anchor];
        const now = Date.now();
        const dbl = lastTap.current.id === card.id && now - lastTap.current.t < DOUBLE_MS;
        lastTap.current = dbl ? { id: '', t: 0 } : { id: card.id, t: now };
        if (dbl) onPickUnit(card); else onPick(card);
        return;
      }
      const lo = Math.min(d.anchor, hit);
      const hi = Math.max(d.anchor, hit);
      onSweep(d.row.slice(lo, hi + 1).map((c) => c.id), d.mode);
    },
    onPointerCancel: () => endDrag(),
  });

  const sel = preview ?? selected;

  return (
    <div className={`sj-hand${lifted ? ' is-turn' : ''}${disabled ? ' is-off' : ''}`} ref={wrapRef}>
      {chunks.map((row, r) => (
        <div
          className="sj-hand-row"
          key={r}
          style={{ ['--step' as string]: `${step}px` }}
          {...rowHandlers(row)}
        >
          {row.map((c, i) => {
            // 扇形：中间略高、两端略低，角度也跟着走一点，别排成一条直尺
            const t = row.length > 1 ? (i / (row.length - 1)) * 2 - 1 : 0;
            const on = sel.has(c.id);
            return (
              <button
                key={c.id}
                data-cid={c.id}
                // 类名必须带 sj- 前缀：全局 styles.css 里的 `.hint` 是段落助手样式
                // （margin: 12px 0 0），套到牌上会把这张牌整个往下压 12px ——
                // 手牌换行之后，整行牌会跟着提示的出现/消失上下跳，正是「绝不移动牌」要禁的
                className={`sj-hand-card${on ? ' on' : ''}${!on && hinted?.has(c.id) ? ' sj-hint' : ''}${
                  !on && blamed?.has(c.id) ? ' sj-blame' : ''}`}
                style={{
                  ['--i' as string]: i,
                  ['--rot' as string]: `${(t * 3.2).toFixed(2)}deg`,
                  ['--dy' as string]: `${(-(1 - t * t) * 6).toFixed(1)}px`,
                }}
                disabled={disabled}
                aria-pressed={on}
                // 键盘可达性：Enter / Space 等价于单击。自己接管掉，免得再合成一次 click
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  onPick(c);
                }}
              >
                <span className="sj-hand-card-flip">
                  <span className="sj-hand-card-lift">
                    <PlayingCard card={c} faceDown={false} size="hand" />
                    <span className="sj-hand-sel" aria-hidden="true" />
                    <span className="sj-hand-tick" aria-hidden="true">✓</span>
                    <span className="sj-hand-ring" aria-hidden="true" />
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
