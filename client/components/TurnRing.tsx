import { useEffect, useRef, useState } from 'react';

import { sound } from '../sound.ts';

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
/**
 * 自己的回合只剩 5 秒时补一记很轻的滴答（DESIGN 3.6）。
 *
 * 轮转本身只有一颗提示音、没有语音，低头在手牌里挑牌时又看不见倒计时环 ——
 * 这一下是唯一的补救。只响一次、音量只有 `turn` 的三分之一，是提醒不是催命。
 */
export function useHurryTick(deadline: number | null, mine: boolean) {
  useEffect(() => {
    if (!deadline || !mine) return;
    const at = deadline - 5000 - Date.now();
    // 回合开始时就已经不足 5 秒（断线回来、超时代打接管）就不补了，
    // 立刻响一下只会吓人一跳，信息量还是零。
    if (at <= 0) return;
    const id = setTimeout(() => sound.play('hurry'), at);
    return () => clearTimeout(id);
  }, [deadline, mine]);
}

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
