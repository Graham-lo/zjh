#!/usr/bin/env node
/**
 * 用 macOS 自带的婷婷把 VOICE_LINES 渲染成一套语音包。
 *
 * 为什么要预渲染：浏览器的 speechSynthesis 音色由设备决定 —— iOS 是 Siri、
 * 安卓是 Google TTS、macOS 是婷婷，同一张牌桌上每个人听到的播报都不一样。
 * 事先渲染成音频随前端一起发，所有人听到的就是同一个声音。
 *
 * 台词直接从 client/sound.ts 的 VOICE_LINES 里读，避免两处各写一份跑偏；
 * 这里只额外配一张语速表（浏览器 TTS 用 rate/pitch 表达情绪，say 只有语速，
 * 所以用「每分钟字数」近似同一套情绪）。
 *
 *   node scripts/voice-pack.mjs
 *
 * 产物写进 client/public/voice/，vite 构建时会原样拷进 dist/client/。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'client', 'public', 'voice');
const VOICE = 'Tingting'; // zh_CN，macOS 自带；`say -v '?'` 可以看全部音色
const FORMAT = 'm4a';

/** 每分钟字数。上头的那几句念快一点，认怂的那两句念慢一点。 */
const RATE = { fast: 230, normal: 180, slow: 170 };
const TEMPO = {
  allin: RATE.fast, accept: RATE.fast, baozi: RATE.fast, shunjin: RATE.fast,
  fold: RATE.slow, sanpai: RATE.slow,
};

/** 从 sound.ts 里抠出 VOICE_LINES 的 key 和台词 */
function readLines() {
  const src = readFileSync(join(ROOT, 'client', 'sound.ts'), 'utf8');
  const block = src.match(/export const VOICE_LINES[^{]*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('没在 client/sound.ts 里找到 VOICE_LINES');
  const lines = [...block[1].matchAll(/^\s*(\w+):\s*\{\s*text:\s*'([^']+)'/gm)]
    .map(([, key, text]) => ({ key, text }));
  if (!lines.length) throw new Error('VOICE_LINES 解析出来是空的');
  return lines;
}

const lines = readLines();
const tmp = mkdtempSync(join(tmpdir(), 'zjh-voice-'));
mkdirSync(OUT, { recursive: true });

let total = 0;
for (const { key, text } of lines) {
  const aiff = join(tmp, `${key}.aiff`);
  const out = join(OUT, `${key}.${FORMAT}`);
  const rate = TEMPO[key] ?? RATE.normal;
  execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', aiff, text]);
  // 64kbps AAC 单声道足够放一句话，一句压下来不到 20KB
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', aiff, out]);
  const size = statSync(out).size;
  total += size;
  console.log(`${key.padEnd(9)} ${String(rate).padStart(3)} 字/分  ${text.padEnd(8)} ${size} B`);
}

writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify({ format: FORMAT, lines: lines.map((l) => l.key) }, null, 2)}\n`,
);
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${lines.length} 句，共 ${(total / 1024).toFixed(1)} KB → ${OUT}`);
