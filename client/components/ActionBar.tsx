import { useEffect, useRef, useState } from 'react';
import {
  allInBase as calcAllInBase, allInCost as calcAllIn, callCost as calcCall, canAllInNow, canAutoStart, canCompareNow,
  EMOTES, evaluateHand, type GameCommand, type PublicPlayer, type PublicRoom,
} from '../../shared/game.ts';
import { handRarity } from './Card.tsx';
import { useCountdown } from './TurnRing.tsx';

const fmt = (n: number) => n.toLocaleString('zh-CN');

export function ActionBar({
  room,
  me,
  cmd,
  onInvite,
  onInviteCli,
}: {
  room: PublicRoom;
  me: PublicPlayer;
  cmd(c: GameCommand): void;
  onInvite(): void;
  onInviteCli(): void;
}) {
  const isHost = room.hostId === me.id;
  const myTurn = room.phase === 'playing' && room.turnSeat === me.seat && me.status === 'active';
  const left = useCountdown(myTurn ? room.turnDeadline : null);
  // 自动开局的倒计时。服务端把「什么时候会自动发生」写在 nextAt 里，
  // 界面照着念，而不是让人对着一句「稍后」干等。
  const autoIn = useCountdown(room.phase === 'lobby' ? (room.nextAt ?? null) : null);

  // 这些数字和服务端用的是同一份函数，不会出现"按钮显示能跟、点了说钱不够"
  const cost = calcCall(room, me);
  const comparePrice = cost * 2;
  const active = room.players.filter((p) => p.status === 'active');
  const compareOpen = canCompareNow(room);
  /*
   * 钱不够**不是**「只能弃牌」。名义价钱高过身家时，引擎会把这一口夹到全部筹码
   * 打出去（「全押跟」，见 shared/game.ts 的 `pay`），所以按钮照样能点，
   * 只是文案要老实写成「全押 X」—— 按下去会推光，这件事必须写在按钮上。
   */
  const canCall = me.chips > 0;
  const callPrice = Math.min(cost, me.chips);
  const callShove = callPrice < cost;
  const canCompare = me.chips > 0;
  const comparePay = Math.min(comparePrice, me.chips);
  const compareShove = comparePay < comparePrice;
  // 梭哈 = 全押：我要掏的就是我的全部筹码，和别人有多少钱无关。
  const shovePrice = calcAllIn(room, me);
  const shoveOpen = canAllInNow(room);
  /*
   * 梭哈永远不比跟注便宜 —— 跟不起的人**没有**梭哈，他的按钮是上面那个「全押跟」。
   * 和引擎 doAllIn 同一条门槛，免得摆一个点下去只会报错的按钮。
   */
  const canShove = me.chips > cost && active.length > 1 && shoveOpen;
  const handType = me.looked && me.hand.length === 3 ? evaluateHand(me.hand).name : null;
  // 我梭哈之后别人要按的闷牌单价 = 我的身家换算回闷牌口径（看牌的我只算一半）
  const shoveBase = calcAllInBase(room, me);
  const shove = room.allIn;
  /**
   * 表态阶段我自己要掏的数。看牌是自由动作、不占行动权，所以在这里点一下看牌，
   * 倍率立刻从 1 跳到 2，这个数也就当场翻倍 —— 翻过身家就夹到全部筹码，
   * 和服务端 doCall 的算法逐字一致，不会出现「按钮显示能接、点了说钱不够」。
   */
  const acceptPrice = shove ? Math.min(shove.base * (me.looked ? 2 : 1), me.chips) : 0;
  const acceptShove = shove ? acceptPrice < shove.base * (me.looked ? 2 : 1) : false;
  // 兜底：万一房间是老快照，别把 undefined 显示出来
  const allInFrom = room.settings.allInFromRound ?? 3;

  const tiers = room.settings.betOptions.filter((x) => x > room.betUnit);
  /**
   * 自动跟注（挂机）。跟不起时照发 call —— 引擎的 `pay` 会夹到全部筹码，也就是全押跟，
   * 结算走边池。（不是梭哈：梭哈现在是全押，而且不能比跟注便宜，短码根本没有这个动作。）
   * 有人梭哈时会自动关掉交还给人 —— 接不接一个全场开牌的注，不该由一个勾选框替你决定。
   */
  const [autoCall, setAutoCall] = useState(false);
  const firedRef = useRef('');
  useEffect(() => {
    if (!autoCall) return;
    if (shove) {
      setAutoCall(false);
      return;
    }
    if (!myTurn || me.status !== 'active') return;
    const token = `${room.handNo}:${room.turnCount}`;
    if (firedRef.current === token) return;
    firedRef.current = token;
    const t = setTimeout(() => {
      if (me.chips > 0) cmd({ type: 'call' });
      else cmd({ type: 'fold' });
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCall, myTurn, !!shove, room.handNo, room.turnCount]);

  // 非自己回合弃牌要点两次 —— 用原生 confirm 会打断节奏，手机上尤其难受
  const [armFold, setArmFold] = useState(false);
  useEffect(() => {
    if (!armFold) return;
    const t = setTimeout(() => setArmFold(false), 3000);
    return () => clearTimeout(t);
  }, [armFold]);
  useEffect(() => setArmFold(false), [room.handNo, myTurn]);

  if (room.phase === 'lobby') {
    // 发牌档只在准备阶段能改（引擎那边牌局进行中一律拒 settings），所以开关就放在这里。
    const party = room.settings.dealMode === 'party';
    const seated = room.players.length;
    const readyCount = room.players.filter((p) => p.isBot || p.ready).length;
    return (
      <div className="bar">
        <div className="bar-status">
          <strong>
            {seated}/{room.settings.maxPlayers} 人
          </strong>
          <span>
            已准备 {readyCount} · 底注 {fmt(room.settings.ante)} ·{' '}
            {room.settings.maxRounds > 0 ? `${room.settings.maxRounds} 轮封顶` : '不封顶，打到分胜负'}
          </span>
        </div>
        <div className="bar-actions">
          <button className={`btn ${me.ready ? 'ghost' : 'primary'}`} onClick={() => cmd({ type: 'ready', ready: !me.ready })}>
            {me.ready ? '取消准备' : '准备'}
          </button>
          {me.chips < room.settings.ante * 2 && (
            <button className="btn" onClick={() => cmd({ type: 'top_up' })}>
              补充积分
            </button>
          )}
          {seated < room.settings.maxPlayers && (
            <>
              <button className="btn" onClick={onInvite}>
                邀请好友
              </button>
              <button className="btn" title="复制一条命令，朋友粘到终端就能进这个房间" onClick={onInviteCli}>
                命令行加入
              </button>
              {isHost && (
                <button className="btn" onClick={() => cmd({ type: 'add_bot' })}>
                  + 电脑玩家
                </button>
              )}
            </>
          )}
          {isHost && (
            <button
              className={`btn ${party ? 'primary' : 'ghost'}`}
              title="娱乐增强：大牌更多、碰撞更多（大牌约 54%，默认档约 26%）"
              aria-pressed={party}
              onClick={() => cmd({ type: 'settings', dealMode: party ? 'standard' : 'party' })}
            >
              娱乐增强 {party ? '开' : '关'}
            </button>
          )}
          {isHost && (
            <button
              className="btn primary go"
              disabled={readyCount < 2}
              onClick={() => cmd({ type: 'start' })}
            >
              开始这一局
            </button>
          )}
        </div>
        {isHost && (
          <p className="bar-hint">娱乐增强：大牌更多、碰撞更多（大牌约 54%，默认档约 26%）</p>
        )}
        {canAutoStart(room) && (
          <p className="bar-hint">
            所有人都准备好了，{autoIn > 0 ? `${autoIn} 秒后自动开局` : '马上自动开局'}
          </p>
        )}
      </div>
    );
  }

  if (room.phase !== 'playing') return null;

  const turnName = room.players.find((p) => p.seat === room.turnSeat)?.name ?? '玩家';
  // 最后 8 秒行动台边缘跟着心跳脉动，和头像上的倒计时环是同一套节律
  const urgent = myTurn && left > 0 && left <= 8;

  return (
    <div className={`bar${urgent ? ' is-urgent' : ''}${shove ? ' is-shove' : ''}`}>
      <div className="bar-status">
        {shove ? (
          me.status !== 'active' ? (
            <strong className="dim">{shove.initiatorName} 梭哈了 {fmt(shove.amount)}</strong>
          ) : myTurn ? (
            <strong className="shove-call">
              {shove.initiatorName} 梭哈 {fmt(shove.amount)} · 接还是弃？{left}s
            </strong>
          ) : (
            <strong className="dim">
              {shove.initiatorName} 梭哈了 {fmt(shove.amount)}，等 {room.players.find((p) => p.seat === room.turnSeat)?.name ?? '玩家'} 表态…
            </strong>
          )
        ) : me.status === 'waiting' ? (
          <strong>已入座，等待下一局</strong>
        ) : me.status === 'folded' ? (
          <strong className="dim">你已弃牌，等待本局结束</strong>
        ) : myTurn ? (
          <strong className={left <= 8 ? 'urgent' : 'hot'}>轮到你 · {left}s</strong>
        ) : (
          <strong className="dim">等待 {turnName} 行动…</strong>
        )}
        <span className="bar-meta">
          {handType && <b className={`hand-type r-${handRarity(handType)}`} title="你的牌型">{handType}</b>}
          第 {room.handNo} 局 · 第 {room.roundNo}
          {room.settings.maxRounds > 0 ? `/${room.settings.maxRounds}` : ''} 轮 · 底注 {fmt(room.betUnit)}
          {compareOpen ? ' · 可比牌' : ' · 首轮中'}
          {/* 梭哈还没开放时把门槛写出来，省得有人一直找那个按钮。
              解锁只看轮次 —— 没有「有人跟不起就提前放开」这回事了。 */}
          {!shoveOpen && ` · 第 ${allInFrom} 轮起可梭哈（全押）`}
        </span>
      </div>

      {me.status === 'active' && shove && (
        <div className="bar-actions shove-choice">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          {/* 有人梭哈时只有两条路：接，或者弃。
              按钮上写的是**我自己**要掏的数，和播报里发起人的金额本来就可以不一样 ——
              闷牌半价、看牌双倍。上面那个「看牌」按下去，这个数会当场变成两倍。 */}
          <button
            className="btn primary accept"
            disabled={!myTurn || acceptPrice <= 0}
            title={
              me.looked
                ? `看过牌，接梭哈是双倍：${fmt(acceptPrice)}`
                : `闷牌半价：${fmt(acceptPrice)}；现在看牌的话这一份会变成 ${fmt(Math.min(shove.base * 2, me.chips))}`
            }
            onClick={() => cmd({ type: 'call' })}
          >
            {acceptShove ? '全押接下' : '接受梭哈'} {fmt(acceptPrice)}
            {!me.looked && !acceptShove && <small className="hint-half"> 闷牌半价</small>}
          </button>
          {/* 弃牌不占行动权：别人梭哈、还没轮到我表态的时候，我照样可以直接走人。
              这里原来跟着 myTurn 一起禁用，等于把「随时可以放弃」这条规则在界面上
              锁掉了 —— 引擎其实一直允许（doFold 只看你还在不在这一局里）。
              不是自己回合时和主行动排一样点两次，防手滑。 */}
          <button
            className={`btn fold${armFold ? ' armed' : ''}`}
            onClick={() => {
              if (myTurn) return cmd({ type: 'fold' });
              if (!armFold) return setArmFold(true);
              setArmFold(false);
              cmd({ type: 'fold' });
            }}
          >
            {armFold ? '再点一次确认' : '弃牌'}
          </button>
        </div>
      )}

      {/* 主行动排：弃牌 / 跟注 / 加注档 / 梭哈 一次排开，点一下就走 ——
          下拉框要点两次还挡住牌桌。手机上靠 flex-wrap 自然折成两行，
          第一行是最常用的三个大目标，加注档退到第二行。 */}
      {me.status === 'active' && !shove && (
        <div className="bar-actions">
          {!me.looked && (
            <button className="btn look" onClick={() => cmd({ type: 'look' })}>
              看牌
            </button>
          )}
          {/* 弃牌和看牌一样不占行动权：牌烂就直接走，不用干等别人慢慢想 */}
          <button
            className={`btn fold${armFold ? ' armed' : ''}`}
            onClick={() => {
              if (myTurn) return cmd({ type: 'fold' });
              if (!armFold) return setArmFold(true);
              setArmFold(false);
              cmd({ type: 'fold' });
            }}
          >
            {armFold ? '再点一次确认' : '弃牌'}
          </button>
          <button
            className="btn primary call"
            disabled={!myTurn || !canCall}
            title={callShove ? `台面要 ${fmt(cost)}，你只剩 ${fmt(callPrice)} —— 点下去会全部推出去` : undefined}
            onClick={() => cmd({ type: 'call' })}
          >
            {callShove ? '全押' : '跟注'} {fmt(callPrice)}
          </button>
          {tiers.map((x) => (
            <button
              key={x}
              className="btn tier"
              disabled={!myTurn || me.chips <= x * (me.looked ? 2 : 1)}
              title={`本次需要投入 ${fmt(x * (me.looked ? 2 : 1))}`}
              onClick={() => cmd({ type: 'raise', unit: x })}
            >
              加注 {fmt(x)}
            </button>
          ))}
          {/* 条件不满足时干脆不显示，而不是摆一个点不动的按钮 */}
          {canShove && (
            <button
              className="btn allin"
              disabled={!myTurn}
              title={
                `全押：你把全部 ${fmt(shovePrice)} 推出去。其他人按各自的倍率接 ——` +
                `闷牌一份 ${fmt(shoveBase)}、看牌两份 ${fmt(shoveBase * 2)}，掏不动就全押接`
              }
              onClick={() => cmd({ type: 'all_in' })}
            >
              梭哈（全押 {fmt(shovePrice)}，其他人可以接或弃）
            </button>
          )}
        </div>
      )}

      {/* 比牌行：谁能被比一目了然，自动跟注靠右单独站着不抢戏 */}
      {me.status === 'active' && !shove && (
        <div className="compare-row">
          {myTurn && compareOpen && active.length > 1 ? (
            <>
              <span>{compareShove ? '全押比牌' : '比牌'} {fmt(comparePay)}：</span>
              {active
                .filter((p) => p.id !== me.id)
                .map((p) => (
                  <button
                    key={p.id}
                    className="btn tiny"
                    disabled={!canCompare}
                    onClick={() => cmd({ type: 'compare', targetId: p.id })}
                  >
                    {p.avatar} {p.name}
                  </button>
                ))}
            </>
          ) : (
            <span>{compareOpen ? `比牌 ${fmt(comparePay)} · 轮到你时可选对手` : '首轮走完后开放比牌'}</span>
          )}
          <button
            className={`btn tiny auto${autoCall ? ' on' : ''}`}
            title="自动跟注；跟不起时自动梭哈。有人梭哈会自动交还给你决定"
            onClick={() => setAutoCall((v) => !v)}
          >
            {autoCall ? '● 自动跟注中' : '自动跟注'}
          </button>
        </div>
      )}

      {isHost && room.players.some((p) => !p.isBot && !p.online && p.status === 'active') && (
        <div className="compare-row rescue">
          <span>有人掉线卡住牌桌：</span>
          {room.players
            .filter((p) => !p.isBot && !p.online && p.status === 'active')
            .map((p) => (
              <button key={p.id} className="btn tiny danger" onClick={() => cmd({ type: 'remove_player', targetId: p.id })}>
                代 {p.name} 弃牌
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function EmoteBar({ cmd }: { cmd(c: GameCommand): void }) {
  return (
    <div className="emote-bar">
      {EMOTES.map((e) => (
        <button key={e} className="emote-btn" onClick={() => cmd({ type: 'emote', id: e })} aria-label={`发送表情 ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}
