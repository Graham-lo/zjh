/**
 * 全部音效都是 WebAudio 现场合成的 —— 没有音频文件，
 * 首屏不多一个字节，也不用等资源加载就能出声。
 */
type Name =
  | 'deal' | 'flip' | 'chip' | 'turn' | 'win' | 'lose' | 'msg' | 'tap'
  // 重构后新增的几下：比牌对撞、梭哈闷响、金币流、好牌提示、末段心跳
  | 'clash' | 'shove' | 'coin' | 'ding' | 'heart'
  // 升级：亮主拍牌、收圈横扫、倍数戳记（DESIGN 3.6）
  | 'slam' | 'sweep' | 'stamp';

class Sound {
  ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  enabled = (window as unknown as { __zjhSound?: boolean }).__zjhSound !== false;

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem('zjh:sound', on ? 'on' : 'off');
    } catch {
      /* 隐私模式下写不了就算了 */
    }
    if (on) this.play('tap');
  }

  /** 浏览器要求音频必须由用户手势解锁 */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const len = Math.floor(this.ctx.sampleRate * 0.4);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get context() {
    return this.ctx;
  }

  private tone(freq: number, at: number, dur: number, gain = 0.16, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + at);
    g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + dur + 0.02);
  }

  /**
   * 钟琴 / 马林巴质感的一颗音。
   *
   * 裸正弦听起来像寻呼机，是因为它只有基频、而且起音一刀切。真实的敲击体
   * 有两个特征：一是泛音**不成整数倍**（钟类乐器的第一个泛音大约在 2.76 倍，
   * 这个"不和谐"正是金属的味道），二是泛音衰减得比基频快得多，所以敲下去
   * 那一瞬是"叮"、余下的是干净的嗡。同度叠一层三角波补一点木头的暖，
   * 免得整颗音太玻璃。起音留 8ms 而不是 0，避免爆音。
   */
  private bell(freq: number, at: number, dur = 0.6, gain = 0.1) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + at;
    // [波形, 频率倍数, 增益占比, 衰减占比] —— 泛音只活到基频的四成时长
    const parts: [OscillatorType, number, number, number][] = [
      ['sine', 1, 1, 1],
      ['sine', 2.76, 0.35, 0.4],
      ['triangle', 1, 0.25, 0.7],
    ];
    for (const [type, mul, level, decay] of parts) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * mul, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain * level, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * decay);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur * decay + 0.02);
    }
  }

  private swish(at: number, dur = 0.16, gain = 0.12, from = 2600, to = 700) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, ctx.currentTime + at);
    filter.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime + at);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(ctx.currentTime + at);
    src.stop(ctx.currentTime + at + dur + 0.02);
  }

  play(name: Name, index = 0) {
    if (!this.enabled) return;
    this.unlock();
    if (!this.ctx) return;
    switch (name) {
      case 'deal':
        return this.swish(index * 0.07, 0.13, 0.1);
      case 'flip':
        return this.swish(0, 0.08, 0.09, 4200, 1400);
      case 'chip':
        // index 是这一注飞出的第几枚筹码，音高逐枚递进，听得出「加注更大」
        this.tone(1650 + index * 180, 0, 0.05, 0.09, 'triangle');
        return this.tone(2200 + index * 200, 0.045, 0.05, 0.06, 'triangle');
      case 'clash':
        // 比牌对撞：一记低频闷响垫底，上面盖一层金属擦击
        this.tone(90, 0, 0.34, 0.24, 'sine');
        this.swish(0, 0.2, 0.16, 6000, 900);
        return this.tone(1560, 0.03, 0.16, 0.1, 'square');
      case 'shove':
        // 梭哈：先半拍静默感（低音下坠），再一记砸下的重音
        this.tone(220, 0, 0.26, 0.14, 'sawtooth');
        this.tone(70, 0.24, 0.5, 0.3, 'sine');
        return this.swish(0.24, 0.34, 0.18, 3400, 320);
      case 'coin':
        // 金币流：一串上行的清脆声，跟着筹码飞进赢家的堆里
        return [1180, 1480, 1760, 2100, 2480].forEach((f, i) =>
          this.tone(f, index * 0.05 + i * 0.035, 0.09, 0.07, 'triangle'),
        );
      case 'ding':
        this.tone(2100, 0, 0.16, 0.1, 'sine');
        return this.tone(3150, 0.07, 0.22, 0.06, 'sine');
      case 'heart':
        // 倒计时最后 8 秒的心跳，两下一组
        this.tone(62, 0, 0.14, 0.2, 'sine');
        return this.tone(58, 0.19, 0.18, 0.15, 'sine');
      case 'turn':
        // 轮到你了：E5→A5 一个上行小琶音，像轻轻敲了下门铃，而不是响警报。
        // 第二颗略轻、拖得略长，尾音自然落下去，催促感全靠上行而不是音量。
        this.bell(659.25, 0, 0.5, 0.1);
        return this.bell(880, 0.09, 0.5, 0.085);
      case 'win':
        return [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.075, 0.3, 0.13, 'triangle'));
      case 'lose':
        this.tone(330, 0, 0.2, 0.1, 'sine');
        return this.tone(247, 0.13, 0.28, 0.09, 'sine');
      case 'msg':
        return this.tone(1400, 0, 0.09, 0.07, 'sine');
      case 'slam':
        // 亮主：一张牌被拍到桌面上。木头的闷响 + 一点纸面擦过的高频
        this.tone(140, 0, 0.18, 0.26, 'sine');
        this.tone(72, 0.01, 0.3, 0.2, 'sine');
        return this.swish(0, 0.1, 0.12, 5200, 1200);
      case 'sweep':
        // 收圈：四手牌被一把扫向赢家，噪声从高滑到低，尾巴上挑一颗铃
        this.swish(0, 0.26, 0.15, 3800, 520);
        return this.bell(1320, 0.2, 0.34, 0.06);
      case 'stamp':
        // 倍数戳记砸下：先一记闷雷，再一层金属亮边
        this.tone(58, 0, 0.42, 0.34, 'sine');
        this.tone(180, 0.02, 0.22, 0.16, 'sawtooth');
        return this.swish(0.02, 0.24, 0.14, 2600, 260);
      case 'tap':
        return this.tone(1100, 0, 0.04, 0.05, 'sine');
    }
  }
}

export const sound = new Sound();

/**
 * 牌桌语音播报。
 *
 * 两层来源，按优先级：
 *  1. 语音包 —— `/voice/manifest.json` 存在时，播放预先录好/渲染好的音频。
 *     所有设备听到的是同一个声音，也能用真人录音。
 *  2. 浏览器自带的 speechSynthesis —— 没有语音包时的兜底。
 *     不打包任何音频，但音色随设备走（iOS 是 Siri，安卓是 Google TTS，
 *     macOS 是婷婷），每个人听到的不一样。
 *
 * 怎么做语音包见 README 的「语音包」一节。
 */

/**
 * 需要发声的全部台词。key 同时是音频文件名。
 *
 * rate / pitch 只在退回浏览器 TTS 时生效 —— 梭哈和豹子是牌桌上最上头的两下，
 * 语速和音高都往上推，别念得像在报站。用真人语音包时情绪由录音本身决定。
 */
export const VOICE_LINES: Record<string, { text: string; rate?: number; pitch?: number; volume?: number }> = {
  call: { text: '跟注' },
  raise: { text: '加注', rate: 1.25, pitch: 1.1 },
  allin: { text: '梭哈！全下！', rate: 1.45, pitch: 1.45, volume: 1 },
  accept: { text: '接！', rate: 1.4, pitch: 1.3, volume: 1 },
  compare: { text: '比牌', rate: 1.2, pitch: 1.1 },
  fold: { text: '弃牌', rate: 1.05, pitch: 0.95 },
  // 「该你啦」比「该你了」软一点 —— 提醒本来就不该听着像催命
  turn: { text: '该你啦' },
  baozi: { text: '豹子！', rate: 1.4, pitch: 1.45, volume: 1 },
  shunjin: { text: '顺金！', rate: 1.35, pitch: 1.35, volume: 1 },
  jinhua: { text: '金花', rate: 1.2, pitch: 1.15 },
  shunzi: { text: '顺子', rate: 1.15, pitch: 1.05 },
  duizi: { text: '对子' },
  sanpai: { text: '散牌', rate: 1.0, pitch: 0.95 },

  /* ---- 升级（DESIGN 3.6） ---- */
  trump_s: { text: '黑桃主', rate: 1.25, pitch: 1.1 },
  trump_h: { text: '红桃主', rate: 1.25, pitch: 1.1 },
  trump_c: { text: '梅花主', rate: 1.25, pitch: 1.1 },
  trump_d: { text: '方块主', rate: 1.25, pitch: 1.1 },
  trump_pair: { text: '一对，主！', rate: 1.35, pitch: 1.25, volume: 1 },
  nt: { text: '无主！', rate: 1.4, pitch: 1.35, volume: 1 },
  kou: { text: '扣底', rate: 1.05 },
  bi: { text: '毙！', rate: 1.45, pitch: 1.35, volume: 1 },
  dig: { text: '抠底！', rate: 1.45, pitch: 1.4, volume: 1 },
  levelup: { text: '升级！', rate: 1.3, pitch: 1.2 },
  daguang: { text: '大光！', rate: 1.4, pitch: 1.4, volume: 1 },
  xiaoguang: { text: '小光！', rate: 1.35, pitch: 1.3, volume: 1 },
  shangtai: { text: '上台！', rate: 1.35, pitch: 1.3, volume: 1 },
  tongguan: { text: '通关！', rate: 1.45, pitch: 1.45, volume: 1 },
};

export type VoiceKey =
  | 'call' | 'raise' | 'allin' | 'accept' | 'compare' | 'fold' | 'turn'
  | 'baozi' | 'shunjin' | 'jinhua' | 'shunzi' | 'duizi' | 'sanpai'
  | 'trump_s' | 'trump_h' | 'trump_c' | 'trump_d' | 'trump_pair' | 'nt'
  | 'kou' | 'bi' | 'dig' | 'levelup' | 'daguang' | 'xiaoguang' | 'shangtai' | 'tongguan';

/** 牌型名 → 语音 key */
export const HAND_VOICE: Record<string, VoiceKey> = {
  豹子: 'baozi',
  顺金: 'shunjin',
  金花: 'jinhua',
  顺子: 'shunzi',
  对子: 'duizi',
  散牌: 'sanpai',
  特殊235: 'sanpai',
};

interface Manifest {
  format: string;
  lines: VoiceKey[];
}

class Voice {
  enabled = (() => {
    try {
      return localStorage.getItem('zjh:voice') !== 'off';
    } catch {
      return true;
    }
  })();

  private picked: SpeechSynthesisVoice | null = null;
  private primed = false;
  private clips = new Map<VoiceKey, AudioBuffer>();
  private packState: 'unknown' | 'loading' | 'ready' | 'absent' = 'unknown';
  private playing: AudioBufferSourceNode | null = null;

  get available() {
    return typeof speechSynthesis !== 'undefined' || this.packState === 'ready';
  }

  /** 当前用的是语音包还是浏览器 TTS，给设置界面显示用 */
  get source(): 'pack' | 'tts' | 'none' {
    if (this.packState === 'ready') return 'pack';
    return typeof speechSynthesis !== 'undefined' ? 'tts' : 'none';
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem('zjh:voice', on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (on) this.play('turn');
    else this.stop();
  }

  /** iOS 要求首次发声必须来自用户手势，所以在第一次点击时先热身 */
  unlock() {
    if (this.primed) return;
    this.primed = true;
    if (typeof speechSynthesis !== 'undefined') {
      this.pickVoice();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    void this.loadPack();
  }

  /* ------------------------------------------------------------ 语音包 */

  private async loadPack() {
    if (this.packState !== 'unknown') return;
    this.packState = 'loading';
    try {
      const res = await fetch('/voice/manifest.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error('no pack');
      const manifest = (await res.json()) as Manifest;
      const ctx = sound.context;
      if (!ctx) throw new Error('no audio context');
      const ext = manifest.format || 'm4a';
      await Promise.all(
        manifest.lines.map(async (key) => {
          const r = await fetch(`/voice/${key}.${ext}`, { cache: 'force-cache' });
          if (!r.ok) return;
          this.clips.set(key, await ctx.decodeAudioData(await r.arrayBuffer()));
        }),
      );
      this.packState = this.clips.size > 0 ? 'ready' : 'absent';
    } catch {
      // 没装语音包是正常情况，安静地退回 TTS
      this.packState = 'absent';
    }
  }

  private stop() {
    try {
      this.playing?.stop();
    } catch {
      /* 已经停了 */
    }
    this.playing = null;
    speechSynthesis?.cancel();
  }

  /* --------------------------------------------------------------- TTS */

  private pickVoice() {
    if (this.picked || typeof speechSynthesis === 'undefined') return;
    const all = speechSynthesis.getVoices();
    if (!all.length) {
      speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice(), { once: true });
      return;
    }
    this.picked =
      all.find((v) => v.lang === 'zh-CN' && v.localService) ??
      all.find((v) => v.lang === 'zh-CN') ??
      all.find((v) => v.lang.startsWith('zh')) ??
      null;
  }

  /**
   * 播一句台词。新的一句会打断上一句 —— 机器人连着行动时，
   * 排队播报会越落越远，宁可只听到最新的那一下。
   */
  play(key: VoiceKey) {
    if (!this.enabled) return;
    const clip = this.clips.get(key);
    const ctx = sound.context;
    if (clip && ctx) {
      this.stop();
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      src.buffer = clip;
      src.connect(gain).connect(ctx.destination);
      src.onended = () => {
        if (this.playing === src) this.playing = null;
      };
      src.start();
      this.playing = src;
      return;
    }
    this.speak(key);
  }

  private speak(key: VoiceKey) {
    const line = VOICE_LINES[key];
    if (typeof speechSynthesis === 'undefined' || !line) return;
    this.pickVoice();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(line.text);
      if (this.picked) u.voice = this.picked;
      u.lang = this.picked?.lang ?? 'zh-CN';
      u.rate = line.rate ?? 1.15;
      u.pitch = line.pitch ?? 1;
      u.volume = line.volume ?? 0.9;
      speechSynthesis.speak(u);
    } catch {
      /* 播不出来不影响打牌 */
    }
  }
}

export const voice = new Voice();
