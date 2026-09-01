/**
 * 内联 SVG 线稿图标。
 *
 * 全部手写在这里而不是用 emoji 当图标：emoji 在每个系统上长得都不一样
 * （安卓的 🔇 和 iOS 的完全两个风格），做不出统一的金线质感，也没法跟着
 * currentColor 变色。顺带也避免了引入任何图标库或外网字体 —— 玩家在国内，
 * 首屏必须完全离线可用。
 *
 * 统一 24×24 viewBox、1.8 描边、round 端点，视觉重量才一致。
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);

export const IconSoundOn = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
);

export const IconSoundOff = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="m16 9 5 6" />
    <path d="m21 9-5 6" />
  </Svg>
);

/** 语音播报：一个说话的气泡加声波，和纯音效的喇叭区分开 */
export const IconVoice = (p: P) => (
  <Svg {...p}>
    <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Svg>
);

export const IconExit = (p: P) => (
  <Svg {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 8 6 12l4 4" />
    <path d="M6 12h9" />
  </Svg>
);

export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Svg>
);

export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </Svg>
);

/**
 * 睁眼：座位上的「已看牌」徽章。
 *
 * 只有看过牌的人才挂这个标 —— 闷牌不标，用「没有徽章」表示，
 * 一眼扫过去挂着眼睛的就是看过牌的，比两种状态都标干净。
 * 徽章只有十来个像素，描边要比通用图标粗一点才不糊成一团。
 */
export const IconEye = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M2 12s3.7-6.6 10-6.6S22 12 22 12s-3.7 6.6-10 6.6S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.9" />
  </Svg>
);

/** 结算面板上落在赢家头顶的桂冠。实心渐变，和线稿图标不是一路，单独画。 */
export function Laurel({ id = 'laurel' }: { id?: string }) {
  return (
    <svg className="laurel" width="52" height="34" viewBox="0 0 44 30" fill="none" aria-hidden="true">
      <path d="M4 26 L7 8 L15 17 L22 4 L29 17 L37 8 L40 26 Z" fill={`url(#${id})`} stroke="#c9a25e" strokeWidth="1" />
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7ecd2" />
          <stop offset="1" stopColor="#c9a25e" />
        </linearGradient>
      </defs>
    </svg>
  );
}
