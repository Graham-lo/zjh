import { useEffect, useRef, useState } from 'react';

const R = 27;
const C = 2 * Math.PI * R;

/**
 * 头像外圈的倒计时环。用一次 CSS transition 走完，不占用每帧 JS。
 * 最后 8 秒环转红并开始心跳 —— 时间快到了这件事，不该只写在文字里。
 */
export function TurnRing({ deadline, total }: { deadline: number | null; total: number }) {
  const [offset, setOffset] = useState(C);
  const [dur, setDur] = useState(0);
  const raf = useRef(0);
  const left = useCountdown(deadline);
  const urgent = deadline != null && left > 0 && left <= 8;

  useEffect(() => {
    if (!deadline) return;
    const remain = Math.max(0, deadline - Date.now());
    const full = Math.max(1, total * 1000);
    setDur(0);
    setOffset(C * (1 - Math.min(1, remain / full)));
    raf.current = requestAnimationFrame(() => {
      setDur(remain);
      setOffset(C);
    });
    return () => cancelAnimationFrame(raf.current);
  }, [deadline, total]);

  if (!deadline) return null;
  return (
    <svg className={`turn-ring${urgent ? ' urgent' : ''}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle className="turn-ring-track" cx="32" cy="32" r={R} />
      <circle
        className="turn-ring-bar"
        cx="32"
        cy="32"
        r={R}
        style={{ strokeDasharray: C, strokeDashoffset: offset, transition: `stroke-dashoffset ${dur}ms linear` }}
      />
    </svg>
  );
}

/** 只给"轮到我"时用的秒数文字 */
export function useCountdown(deadline: number | null) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!deadline) return setLeft(0);
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);
  return left;
}
