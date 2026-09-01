// 把三个 Node 入口各打成一个自包含文件：
//   dist/server.mjs  游戏服务端（VPS 上只需要 node + dist/）
//   dist/cli.mjs     命令行版客户端
//   dist/mcp.mjs     MCP 服务（让 AI 以普通玩家身份上桌）
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

// ws 内部用 CJS 的 require() 拿 node 内置模块，ESM 产物里要把 require 补回去
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner,
  // ws 的可选原生加速模块，装了就用、没装也能跑
  external: ['bufferutil', 'utf-8-validate'],
};

const targets = [
  { entryPoints: ['server/main.ts'], outfile: 'dist/server.mjs' },
  { entryPoints: ['cli/main.ts'], outfile: 'dist/cli.mjs', bin: true },
  { entryPoints: ['mcp/server.ts'], outfile: 'dist/mcp.mjs', bin: true },
];

for (const t of targets) {
  await build({ ...common, entryPoints: t.entryPoints, outfile: t.outfile });
  if (t.bin) chmodSync(t.outfile, 0o755);
  console.log(`${t.outfile} 构建完成`);
}
