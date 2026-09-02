import { useEffect, useRef, useState } from 'react';

/**
 * 数字滚动。和 `client/table.tsx` 里炸金花底池用的是同一套思路
 * （三次方缓出 + 定时器兜底），单独放一份是为了不去动炸金花那个文件。
 */
export function useCountUp(target: number, ms = 620) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - (1 - k) ** 3;
      const v = Math.round(from + (target - from) * eased);
      current.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // 标签页在后台时 rAF 不会触发，用定时器保证数字最终一定落到位
    const settle = setTimeout(() => {
      current.current = target;
      setValue(target);
    }, ms + 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [target, ms]);
  return value;
}
