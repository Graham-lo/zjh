// 把服务端打成一个自包含的 dist/server.mjs：VPS 上只需要 node + dist/。
import { build } from 'esbuild';

await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  // ws 内部用 CJS 的 require() 拿 node 内置模块，ESM 产物里要把 require 补回去
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  // ws 的可选原生加速模块，装了就用、没装也能跑
  external: ['bufferutil', 'utf-8-validate'],
});
console.log('dist/server.mjs 构建完成');
