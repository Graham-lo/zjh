/**
 * 升级的全屏高潮特效（DESIGN 3.5）。
 *
 * 和炸金花一样按「蓄力 → 冲击 → 收束」编排，节拍由这里的 setTimeout 推进，
 * 位移光影交给 sj.css；全部能被 prefers-reduced-motion 一次关掉。
 * 同一时刻只播一个，排队由 SjTable 的单车道队列负责。
 */
import { useEffect, useState } from 'react';
import { SUIT_SYMBOL, cardFromId, cardLabel, type SjCard, type SjTrumpSuit } from '../../shared/sj/cards.ts';
import { Particles } from '../components/Fx.tsx';
import { PlayingCard } from '../components/Card.tsx';
import { TRUMP_TINT, suitName } from './util.ts';

export type SjFxJob =
  | { kind: 'declare'; trump: SjTrumpSuit; who: string; strength: number; reinforce: boolean }
  | { kind: 'flip'; card: SjCard; trump: SjTrumpSuit }
  | { kind: 'throwFail'; who: string; penalty: number; forcedIds: string[] }
  | { kind: 'dig'; who: string; base: number; multiplier: number; total: number; bottom: SjCard[] }
  | { kind: 'handEnd'; label: string; detail: string; big: boolean }
  | { kind: 'matchEnd'; mine: boolean };

/** 每种特效占屏多久。抠底最长 —— 那是一局里唯一值得停下来看的地方 */
export const SJ_FX_MS: Record<SjFxJob['kind'], number> = {
  declare: 1700,
  flip: 2100,
  throwFail: 1600,
  dig: 4400,
  handEnd: 2800,
  matchEnd: 4200,
};

function useBeats(steps: number[]) {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timers = steps.map((ms, i) => setTimeout(() => setBeat(i + 1), ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return beat;
}

/* --------------------------------------------------------------- 亮主 */

function Declare({ job }: { job: Extract<SjFxJob, { kind: 'declare' }> }) {
  const glyph = job.trump === 'NT' ? '無' : SUIT_SYMBOL[job.trump];
  const word = job.trump === 'NT' ? '无 主' : `${suitName(job.trump)} 主`;
  return (
    <div className="overlay sj-fx sj-fx-declare" style={{ ['--tint' as string]: TRUMP_TINT[job.trump] }} aria-hidden="true">
      <div className="sj-fx-pool" />
      {/* 花色符号从桌心炸开一圈 */}
      {Array.from({ length: 14 }, (_, i) => (
        <i
          key={i}
          className="sj-fx-pip"
          style={{
            ['--px' as string]: `${(Math.cos((i / 14) * Math.PI * 2) * (170 + (i % 4) * 40)).toFixed(0)}px`,
            ['--py' as string]: `${(Math.sin((i / 14) * Math.PI * 2) * (120 + (i % 3) * 46)).toFixed(0)}px`,
            ['--pd' as string]: `${(i % 5) * 40}ms`,
          }}
        >
          {glyph}
        </i>
      ))}
      <div className="sj-fx-core">
        <div className="sj-fx-word">{word}</div>
        <div className="sj-fx-who">
          {job.who} {job.reinforce ? '加固' : job.strength >= 3 ? '反主' : '亮主'}
          {job.strength === 2 ? ' · 一对' : job.strength >= 3 ? ' · 一对王' : ''}
        </div>
      </div>
      <div className="overlay-vignette" />
    </div>
  );
}

/* ----------------------------------------------------------- 翻底定主 */

function Flip({ job }: { job: Extract<SjFxJob, { kind: 'flip' }> }) {
  const beat = useBeats([120]);
  return (
    <div className="overlay sj-fx sj-fx-flip" style={{ ['--tint' as string]: TRUMP_TINT[job.trump] }} aria-hidden="true">
      <div className="sj-fx-pool" />
      <div className="sj-fx-core">
        <div className={`sj-fx-flipcard${beat ? ' up' : ''}`}>
          <PlayingCard card={job.card} faceDown={!beat} size="big" />
        </div>
        <div className="sj-fx-who">
          无人亮主 · 翻底定主 <b>{cardLabel(job.card)}</b> → {job.trump === 'NT' ? '无主' : `${suitName(job.trump)} 主`}
        </div>
      </div>
      <div className="overlay-vignette" />
    </div>
  );
}

/* --------------------------------------------------------------- 甩牌失败 */

function ThrowFail({ job }: { job: Extract<SjFxJob, { kind: 'throwFail' }> }) {
  // 强制打出的那一手是**已经落到桌上的公开牌**，写出来所有人才知道这一圈在比什么；
  // 只说"被打回来了"会让人以为这一手根本没出成（其实只是其余的牌退回了手里）。
  const forced = job.forcedIds.map(cardFromId).map(cardLabel).join(' ');
  return (
    <div className="overlay sj-fx sj-fx-fail" aria-hidden="true">
      <div className="sj-stamp sj-stamp-red">
        <span>甩牌失败</span>
        <b>−10</b>
      </div>
      <div className="sj-fx-who">
        {job.who} 压不住，已强制打出 <b className="sj-fx-forced">{forced}</b>，其余退回手里
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 抠底 */

function Dig({ job }: { job: Extract<SjFxJob, { kind: 'dig' }> }) {
  // 8 张逐张翻（120ms 一档）→ 倍数戳记砸下 → 总分滚出来
  const beat = useBeats([200, 200 + 8 * 120 + 250, 200 + 8 * 120 + 900]);
  return (
    <div className="overlay sj-fx sj-fx-dig" aria-hidden="true">
      <div className="sj-fx-cap">闲家最后一轮大出 · 抠 底</div>
      <div className="sj-dig-cards">
        {job.bottom.map((c, i) => (
          <span
            key={c.id}
            className={`sj-dig-card${(c.rank === 5 || c.rank === 10 || c.rank === 13) && c.suit !== 'J' ? ' is-point' : ''}`}
            style={{ ['--i' as string]: i }}
          >
            <PlayingCard card={c} faceDown={beat < 1} size="big" />
          </span>
        ))}
      </div>
      <div className="sj-dig-math">
        <span className="sj-dig-base">
          {job.base} <i>底分</i>
        </span>
        <span className={`sj-stamp sj-stamp-red sj-dig-mult${beat >= 2 ? ' in' : ''}`}>
          <b>×{job.multiplier}</b>
          <span>收圈牌张数决定</span>
        </span>
        <span className={`sj-dig-total${beat >= 3 ? ' in' : ''}`}>= {job.total}</span>
      </div>
      <div className="sj-fx-who">{job.who} 收下最后一圈</div>
      <div className="overlay-vignette" />
    </div>
  );
}

/* --------------------------------------------------------------- 结算 */

function HandEnd({ job }: { job: Extract<SjFxJob, { kind: 'handEnd' }> }) {
  return (
    <div className="overlay sj-fx sj-fx-end" aria-hidden="true">
      <div className={`sj-fx-word${job.big ? ' big' : ''}`}>{job.label}</div>
      <div className="sj-fx-who">{job.detail}</div>
    </div>
  );
}

function MatchEnd({ job }: { job: Extract<SjFxJob, { kind: 'matchEnd' }> }) {
  return (
    <div className="overlay sj-fx sj-fx-match" aria-hidden="true">
      <Particles count={20} className="sj-fx-spark" />
      <div className="sj-fx-word big">通 关</div>
      <div className="sj-fx-who">{job.mine ? '你们这一队打穿了整条阶梯' : '对方打穿了整条阶梯'}</div>
      <div className="overlay-vignette" />
    </div>
  );
}

export function SjFx({ job, onDone }: { job: SjFxJob; onDone(): void }) {
  useEffect(() => {
    const t = setTimeout(onDone, SJ_FX_MS[job.kind]);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  switch (job.kind) {
    case 'declare':
      return <Declare job={job} />;
    case 'flip':
      return <Flip job={job} />;
    case 'throwFail':
      return <ThrowFail job={job} />;
    case 'dig':
      return <Dig job={job} />;
    case 'handEnd':
      return <HandEnd job={job} />;
    case 'matchEnd':
      return <MatchEnd job={job} />;
  }
}
