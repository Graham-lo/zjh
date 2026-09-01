// 一条命令同时起服务端（类型剥离 + 热重启）和 Vite 前端。
// 前端在 5173，实时连接由 Vite 代理到 8787 的 Node 服务端。
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const procs = [
  spawn(process.execPath, ['--watch', '--watch-preserve-output', 'server/main.ts'], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ZJH_DB: process.env.ZJH_DB ?? resolve(root, '.dev.db'), PORT: '8787' },
  }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host'], { stdio: 'inherit', cwd: root }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
