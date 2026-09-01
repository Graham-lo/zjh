import { env } from 'cloudflare:workers';
import { applyCommand, createHumanPlayer, createInitialRoom, GameError, runBots, sanitizeRoom, type GameCommand, type RoomState } from '@/lib/game';

const ALLOWED_COMMANDS = new Set(['ready', 'start', 'look', 'call', 'all_in', 'raise', 'fold', 'compare', 'add_bot', 'remove_player', 'reset_chips', 'new_round', 'leave']);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = ''; for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function newToken(): string { const b = new Uint8Array(32); crypto.getRandomValues(b); return bytesToBase64Url(b); }

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomRoomCode(): string {
  const b = new Uint32Array(1); crypto.getRandomValues(b); return String(100000 + (b[0] % 900000));
}

function randomNickname(existing: Set<string> = new Set()): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const b = new Uint32Array(1); crypto.getRandomValues(b); const name = `牌友${String(b[0] % 10000).padStart(4, '0')}`;
    if (!existing.has(name)) return name;
  }
  return `牌友${Date.now().toString(36).slice(-6)}`;
}

async function getRow(code: string): Promise<{ state: RoomState; version: number } | null> {
  const row = await env.DB.prepare('SELECT state_json, version FROM rooms WHERE code = ?').bind(code).first<{ state_json: string; version: number }>();
  return row ? { state: JSON.parse(row.state_json) as RoomState, version: row.version } : null;
}

async function mutateRoom(code: string, mutator: (state: RoomState) => void | Promise<void>): Promise<{ state: RoomState; version: number }> {
  for (let attempt = 0; attempt < 7; attempt++) {
    const row = await getRow(code); if (!row) throw new GameError('房间不存在或已过期', 404);
    const state = structuredClone(row.state); await mutator(state);
    const now = Date.now();
    const result = await env.DB.prepare('UPDATE rooms SET state_json = ?, version = version + 1, updated_at = ? WHERE code = ? AND version = ?')
      .bind(JSON.stringify(state), now, code, row.version).run();
    if ((result.meta.changes ?? 0) === 1) return { state, version: row.version + 1 };
  }
  throw new GameError('房间刚刚发生了并发操作，请再试一次', 409);
}

async function authenticate(state: RoomState, playerId: string, token: string): Promise<void> {
  const p = state.players.find((x) => x.id === playerId && !x.isBot);
  if (!p?.tokenHash || !token) throw new GameError('登录凭证无效，请重新加入房间', 401);
  const h = await tokenHash(token); if (h !== p.tokenHash) throw new GameError('登录凭证无效，请重新加入房间', 401);
}

async function createRoom() {
  const token = newToken(), hash = await tokenHash(token);
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomRoomCode(); const host = createHumanPlayer(randomNickname(), 0, hash); const state = createInitialRoom(code, host); const now = Date.now();
    try {
      await env.DB.prepare('INSERT INTO rooms(code, state_json, version, created_at, updated_at) VALUES(?, ?, 0, ?, ?)')
        .bind(code, JSON.stringify(state), now, now).run();
      // Opportunistic cleanup; old private rooms are disposable.
      await env.DB.prepare('DELETE FROM rooms WHERE updated_at < ?').bind(now - 7 * 24 * 60 * 60 * 1000).run().catch(() => undefined);
      return { room: sanitizeRoom(state, host.id), auth: { playerId: host.id, token }, version: 0 };
    } catch (e) {
      const text = String(e); if (!text.toLowerCase().includes('unique') && !text.toLowerCase().includes('constraint')) throw e;
    }
  }
  throw new GameError('创建房间失败，请重试', 503);
}

async function joinRoom(code: string) {
  const token = newToken(), hash = await tokenHash(token); let joinedId = '';
  const { state, version } = await mutateRoom(code, (s) => {
    if (s.players.length >= s.settings.maxPlayers) throw new GameError('房间已满');
    const used = new Set(s.players.map((p) => p.seat)); let seat = 0; while (used.has(seat)) seat++;
    const p = createHumanPlayer(randomNickname(new Set(s.players.map((x) => x.name))), seat, hash); joinedId = p.id; s.players.push(p);
    s.actionSeq += 1;
    const suffix = s.phase === 'playing' ? '，等待下一局' : '';
    s.log.push({ seq: s.actionSeq, at: Date.now(), text: `${p.name} 加入房间${suffix}` });
  });
  return { room: sanitizeRoom(state, joinedId), auth: { playerId: joinedId, token }, version };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const code = url.searchParams.get('code')?.trim() ?? '';
    const playerId = url.searchParams.get('playerId') ?? '';
    const authorization = request.headers.get('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!/^\d{6}$/.test(code)) throw new GameError('房间号格式错误');
    const row = await getRow(code); if (!row) throw new GameError('房间不存在或已过期', 404);
    await authenticate(row.state, playerId, token); return json({ room: sanitizeRoom(row.state, playerId), version: row.version });
  } catch (e) { return handleError(e); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, any>; const op = String(body.op ?? '');
    if (op === 'create') return json(await createRoom());
    if (op === 'join') {
      const code = String(body.code ?? '').trim(); if (!/^\d{6}$/.test(code)) throw new GameError('请输入 6 位房间号');
      return json(await joinRoom(code));
    }
    const code = String(body.code ?? '').trim(), playerId = String(body.playerId ?? ''), token = String(body.token ?? '');
    if (!/^\d{6}$/.test(code)) throw new GameError('房间号格式错误');
    const command = body.command as GameCommand;
    if (!command?.type || !ALLOWED_COMMANDS.has(command.type)) throw new GameError('操作无效');
    const { state, version } = await mutateRoom(code, async (s) => {
      await authenticate(s, playerId, token); applyCommand(s, playerId, command); runBots(s);
    });
    const stillThere = state.players.some((p) => p.id === playerId);
    return json({ room: stillThere ? sanitizeRoom(state, playerId) : null, version });
  } catch (e) { return handleError(e); }
}

function handleError(e: unknown) {
  if (e instanceof GameError) return json({ error: e.message }, e.status);
  console.error(e); return json({ error: '服务器暂时出错，请重试' }, 500);
}
