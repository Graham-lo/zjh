/**
 * 全部音效都是 WebAudio 现场合成的 —— 没有音频文件，
 * 首屏不多一个字节，也不用等资源加载就能出声。
 */
type Name = 'deal' | 'flip' | 'chip' | 'turn' | 'win' | 'lose' | 'msg' | 'tap';

class Sound {
  private ctx: AudioContext | null = null;
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
        this.tone(1750, 0, 0.05, 0.09, 'triangle');
        return this.tone(2300, 0.045, 0.05, 0.06, 'triangle');
      case 'turn':
        this.tone(880, 0, 0.12, 0.12, 'sine');
        return this.tone(1320, 0.11, 0.16, 0.1, 'sine');
      case 'win':
        return [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.075, 0.3, 0.13, 'triangle'));
      case 'lose':
        this.tone(330, 0, 0.2, 0.1, 'sine');
        return this.tone(247, 0.13, 0.28, 0.09, 'sine');
      case 'msg':
        return this.tone(1400, 0, 0.09, 0.07, 'sine');
      case 'tap':
        return this.tone(1100, 0, 0.04, 0.05, 'sine');
    }
  }
}

export const sound = new Sound();

/**
 * 牌桌语音播报。
 *
 * 用浏览器自带的 speechSynthesis，不打包任何音频文件 —— 装机自带的中文发音就是真人录的，
 * 首屏不多一个字节，也不用等音频加载。代价是音色随设备走（iOS 是 Siri 音色，
 * 安卓是 Google TTS，macOS 是"婷婷"一类），不同手机听起来会不一样。
 */
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

  get available() {
    return typeof speechSynthesis !== 'undefined';
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem('zjh:voice', on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (on) this.say('准备好了');
    else speechSynthesis?.cancel();
  }

  /** iOS 要求首次发声必须来自用户手势，所以在第一次点击时先热一下身 */
  unlock() {
    if (this.primed || !this.available) return;
    this.primed = true;
    this.pick();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  private pick() {
    if (this.picked || !this.available) return;
    const all = speechSynthesis.getVoices();
    if (!all.length) {
      // 有些浏览器要等 voiceschanged 才拿得到列表
      speechSynthesis.addEventListener('voiceschanged', () => this.pick(), { once: true });
      return;
    }
    this.picked =
      all.find((v) => v.lang === 'zh-CN' && v.localService) ??
      all.find((v) => v.lang === 'zh-CN') ??
      all.find((v) => v.lang.startsWith('zh')) ??
      null;
  }

  /**
   * 说一句话。新的一句会打断上一句 —— 机器人连着行动时，
   * 排队播报会越落越远，宁可只听到最新的那一下。
   */
  say(text: string) {
    if (!this.enabled || !this.available || !text) return;
    this.pick();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.picked) u.voice = this.picked;
      u.lang = this.picked?.lang ?? 'zh-CN';
      u.rate = 1.15;
      u.pitch = 1.0;
      u.volume = 0.9;
      speechSynthesis.speak(u);
    } catch {
      /* 播不出来不影响打牌 */
    }
  }
}

export const voice = new Voice();
