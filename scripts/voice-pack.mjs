#!/usr/bin/env node
/**
 * 用 macOS 自带的 say 把两张台词表渲染成语音包。
 *
 * 为什么要预渲染：浏览器的 speechSynthesis 音色由设备决定 —— iOS 是 Siri、
 * 安卓是 Google TTS、macOS 是婷婷，同一张牌桌上每个人听到的播报都不一样。
 * 事先渲染成音频随前端一起发，所有人听到的就是同一个声音。
 *
 * **两个游戏用两个发音人**：炸金花是婷婷（女声），升级是 Reed（男声）。
 * 台词表本来就是分开的（client/sound.ts 的 ZJH_VOICE_LINES / SJ_VOICE_LINES），
 * 声音再分开，两张牌桌才真的不像同一个游戏 —— 升级最早就是因为借了炸金花的
 * 「该你啦」才串味的。
 *
 * 台词直接从 client/voice-lines.ts 里读，避免两处各写一份跑偏；这里只额外配一张
 * 语速表（浏览器 TTS 用 rate/pitch 表达情绪，say 只有语速，所以用「每分钟
 * 字数」近似同一套情绪）。
 *
 *   node scripts/voice-pack.mjs
 *
 * 产物写进 client/public/voice/，vite 构建时会原样拷进 dist/client/。
 * 台词删掉时对应的旧音频也会被删，免得语音包里留着已经没人播的句子。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'client', 'public', 'voice');
// `say -v '?'` 可以看全部音色。两个都是 macOS 自带的 zh_CN。
const VOICE = { zjh: 'Tingting', sj: 'Reed (中文（中国大陆）)' };
const FORMAT = 'm4a';

/** 每分钟字数。上头的那几句念快一点，认怂的那两句念慢一点。 */
const RATE = { fast: 230, normal: 180, slow: 170 };
const TEMPO = {
  allin: RATE.fast, accept: RATE.fast, baozi: RATE.fast, shunjin: RATE.fast,
  fold: RATE.slow, sanpai: RATE.slow,
  // 升级：主花色和垫牌报得稳，反主 / 抄底 / 毙 / 抠底 / 通关是全场最上头的几下
  sj_fanzhu: RATE.fast, sj_nt: RATE.fast, sj_chao: RATE.fast, sj_bi: RATE.fast,
  sj_gaibi: RATE.fast, sj_shuai: RATE.fast, sj_dig: RATE.fast, sj_dig2: RATE.fast,
  sj_daguang: RATE.fast, sj_xiaoguang: RATE.fast, sj_shangtai: RATE.fast,
  sj_tongguan: RATE.fast, sj_fen: RATE.fast, sj_last: RATE.fast,
  sj_kou: RATE.slow, sj_dian: RATE.slow, sj_shuai_fail: RATE.slow, sj_shouzhu: RATE.slow,
};

/** 从 sound.ts 里抠出一张台词表的 key 和台词 */
function readLines(src, name, voice) {
  const block = src.match(new RegExp(`export const ${name}[^{]*\\{([\\s\\S]*?)\\n\\} satisfies`));
  if (!block) throw new Error(`没在 client/voice-lines.ts 里找到 ${name}`);
  const lines = [...block[1].matchAll(/^\s*(\w+):\s*\{\s*text:\s*'([^']+)'/gm)]
    .map(([, key, text]) => ({ key, text, voice }));
  if (!lines.length) throw new Error(`${name} 解析出来是空的`);
  return lines;
}

const src = readFileSync(join(ROOT, 'client', 'voice-lines.ts'), 'utf8');
const lines = [
  ...readLines(src, 'ZJH_VOICE_LINES', VOICE.zjh),
  ...readLines(src, 'SJ_VOICE_LINES', VOICE.sj),
];
const tmp = mkdtempSync(join(tmpdir(), 'zjh-voice-'));
mkdirSync(OUT, { recursive: true });

let total = 0;
for (const { key, text, voice } of lines) {
  const aiff = join(tmp, `${key}.aiff`);
  const out = join(OUT, `${key}.${FORMAT}`);
  const rate = TEMPO[key] ?? RATE.normal;
  execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, text]);
  // 64kbps AAC 单声道足够放一句话，一句压下来不到 20KB
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', aiff, out]);
  const size = statSync(out).size;
  total += size;
  console.log(`${key.padEnd(14)} ${String(rate).padStart(3)} 字/分  ${text.padEnd(8)} ${size} B`);
}

// 删掉台词表里已经没有的旧音频（例如去掉「该你啦」之后的 turn.m4a），
// 免得语音包里留着永远不会被播放的文件，还占着首屏之外的一次下载
const keep = new Set(lines.map((l) => `${l.key}.${FORMAT}`));
for (const f of readdirSync(OUT)) {
  if (f === 'manifest.json' || keep.has(f)) continue;
  rmSync(join(OUT, f));
  console.log(`删除 ${f}（台词已移除）`);
}

writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify({ format: FORMAT, lines: lines.map((l) => l.key) }, null, 2)}\n`,
);
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${lines.length} 句，共 ${(total / 1024).toFixed(1)} KB → ${OUT}`);
