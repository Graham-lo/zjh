import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameError } from '../shared/game.ts';
import type { ClientMsg } from '../shared/protocol.ts';
import { Hub, type Conn } from './rooms.ts';
import { Store } from './store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
// 默认放在 dist/ 的上一级（应用目录），这样重新构建不会把牌局清掉，
// 也不依赖启动时的工作目录。生产环境用 ZJH_DB 指到独立的数据目录。
const DB_PATH = process.env.ZJH_DB ?? join(HERE, '..', 'zjh.db');
const CLIENT_DIR = process.env.ZJH_CLIENT ?? join(HERE, 'client');
/** 在 nginx / Caddy 后面时才信任 X-Forwarded-For */
const TRUST_PROXY = process.env.ZJH_TRUST_PROXY === '1';

const store = new Store(DB_PATH);
const hub = new Hub(store);

/* ------------------------------------------------------- 静态资源（全内存） */

interface Asset {
  body: Buffer;
  gzip: Buffer | null;
  br: Buffer | null;
  type: string;
  etag: string;
  cacheControl: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // 语音包（/voice/*）—— 已经是压缩格式，不进 COMPRESSIBLE
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

/**
 * 缓存策略按路径分层：
 *  - /assets/*：Vite 产物带内容哈希，永久缓存；
 *  - /voice/ 下的音频：内容基本不变但文件名没有哈希，缓存一天，
 *    过期后凭 ETag 重新验证（304）。/voice/manifest.json 不在此列，
 *    保持 no-cache，这样新增/替换语音包时客户端能及时感知；
 *  - 其余（index.html、manifest、图标等）：no-cache，每次凭 ETag 验证。
 */
function cacheControlFor(url: string, ext: string): string {
  if (url.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (url.startsWith('/voice/') && ext !== '.json') return 'public, max-age=86400';
  return 'no-cache';
}

/**
 * 整个前端只有几百 KB，启动时一次读进内存并预压缩：
 * 之后每个请求都是内存里的 Buffer，不碰磁盘、不重复压缩。
 */
function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(abs, name);
      const url = `${rel}/${name}`;
      if (statSync(full).isDirectory()) {
        walk(full, url);
        continue;
      }
      const ext = extname(name).toLowerCase();
      const body = readFileSync(full);
      const compressible = COMPRESSIBLE.has(ext) && body.length > 512;
      assets.set(url, {
        body,
        gzip: compressible ? gzipSync(body, { level: 9 }) : null,
        br: compressible
          ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } })
          : null,
        type: MIME[ext] ?? 'application/octet-stream',
        etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
        cacheControl: cacheControlFor(url, ext),
      });
    }
  };
  walk(dir, '');
  return assets;
}

const assets = loadAssets(CLIENT_DIR);
if (assets.size === 0) {
  console.warn(`[http] ${CLIENT_DIR} 里没有前端产物 —— 开发模式下这是正常的（页面由 Vite 提供）`);
}

function serveAsset(req: IncomingMessage, res: ServerResponse, asset: Asset) {
  if (req.headers['if-none-match'] === asset.etag) {
    // 304 也带 Cache-Control，让客户端刷新缓存有效期（对 /voice/ 的一天缓存尤其重要）
    res.writeHead(304, { ETag: asset.etag, 'Cache-Control': asset.cacheControl });
    return res.end();
  }
  const accept = String(req.headers['accept-encoding'] ?? '');
  let body = asset.body;
  const headers: Record<string, string> = {
    'Content-Type': asset.type,
    ETag: asset.etag,
    'Cache-Control': asset.cacheControl,
    Vary: 'Accept-Encoding',
  };
  if (asset.br && accept.includes('br')) {
    body = asset.br;
    headers['Content-Encoding'] = 'br';
  } else if (asset.gzip && accept.includes('gzip')) {
    body = asset.gzip;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ------------------------------------------------------------------ 限流 */

const buckets = new Map<string, { tokens: number; at: number }>();

function allow(ip: string, cost = 1, capacity = 12, refillPerSec = 0.5): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  if (b.tokens < cost) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= cost;
  buckets.set(ip, b);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
}, 5 * 60 * 1000).unref();

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------ HTTP */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...hub.stats(), uptime: Math.round(process.uptime()) }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  const direct = assets.get(path === '/' ? '/index.html' : path);
  if (direct) return serveAsset(req, res, direct);

  // SPA 回退：/?room=123456 这类链接也要能直接打开
  const index = assets.get('/index.html');
  if (index && !extname(path)) return serveAsset(req, res, index);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* ------------------------------------------------------------- WebSocket */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function fail(conn: Conn, e: unknown) {
  if (e instanceof GameError) {
    hub.send(conn, { t: 'error', msg: e.message, fatal: e.status === 401 || e.status === 404 });
  } else {
    console.error('[ws] 未预期的错误', e);
    hub.send(conn, { t: 'error', msg: '服务器出了点问题，请重试' });
  }
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const conn: Conn = { ws, ip: clientIp(req), code: null, playerId: null };
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return hub.send(conn, { t: 'error', msg: '消息格式错误' });
    }
    try {
      switch (msg.t) {
        case 'ping':
          return hub.send(conn, { t: 'pong', at: msg.at, now: Date.now() });
        case 'create':
          if (!allow(conn.ip, 4)) throw new GameError('操作太频繁，请稍后再试', 429);
          return await hub.create(conn, msg.name, msg.avatar, !!msg.agent, msg.accountId, msg.accountToken);
        case 'join':
          // 建/进房间比普通操作贵，避免有人拿 6 位房号扫库
          if (!allow(conn.ip, 3)) throw new GameError('操作太频繁，请稍后再试', 429);
          return await hub.join(conn, String(msg.code ?? '').trim(), msg.name, msg.avatar, !!msg.agent, msg.accountId, msg.accountToken);
        case 'resume':
          if (!allow(conn.ip, 1)) throw new GameError('操作太频繁，请稍后再试', 429);
          return await hub.resume(conn, String(msg.code ?? '').trim(), msg.playerId, msg.token);
        case 'cmd':
          if (!allow(conn.ip, 0.2, 40, 8)) throw new GameError('操作太频繁', 429);
          return hub.command(conn, msg.cmd);
        default:
          return hub.send(conn, { t: 'error', msg: '未知消息' });
      }
    } catch (e) {
      fail(conn, e);
    }
  });

  ws.on('close', () => hub.detach(conn));
  ws.on('error', () => hub.detach(conn));

  const beat = setInterval(() => {
    if (!alive) {
      clearInterval(beat);
      return ws.terminate();
    }
    alive = false;
    ws.ping();
  }, 20_000);
  beat.unref();
  ws.on('close', () => clearInterval(beat));
});

server.listen(PORT, HOST, () => {
  console.log(`[zjh] http://${HOST}:${PORT}  (静态资源 ${assets.size} 个，数据库 ${resolve(DB_PATH)})`);
});

function shutdown() {
  console.log('\n[zjh] 正在关闭…');
  wss.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
