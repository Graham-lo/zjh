import { createHash } from 'node:crypto';

/**
 * 这一份前端产物的指纹，用来做「无感更新」。
 *
 * 上线一次新版本，浏览器里还开着的页面跑的仍然是旧那一份 JS —— 除非有人手动刷新，
 * 否则新功能对正在打牌的人根本不存在，而这恰恰是最需要它的人。指纹的作用是让
 * 服务端能在握手时说一句「我现在是这一版」，页面自己比对，发现自己旧了就挑一个
 * 不打断牌局的时机重新加载（见 client/app.tsx）。
 *
 * 用产物内容算而不是用版本号或时间戳：只有前端真的变了指纹才会变，
 * 光重启服务（改了服务端逻辑、或者机器重启）不会把所有人的页面白刷一遍。
 * 房间状态本来就落在 SQLite 里，刷新之后凭本地那张房卡自动回座，牌局照旧。
 */
export function fingerprint(parts: Iterable<string>): string {
  const sorted = [...parts].sort();
  if (!sorted.length) return 'dev';
  return createHash('sha1').update(sorted.join('\n')).digest('base64url').slice(0, 12);
}

let buildId = 'dev';

export const setBuildId = (id: string) => {
  buildId = id;
};

/** 当前进程正在提供的那一份前端的指纹；开发模式下没有产物，恒为 'dev'。 */
export const getBuildId = () => buildId;
