import { useEffect, useRef } from 'react';
import type { PublicRoom } from '../../shared/game.ts';
import { IconClose, IconLog } from './Icons.tsx';

/** 右侧（手机上是底部抽屉）的牌桌记录。 */
export function Dock({
  room,
  open,
  onToggle,
}: {
  room: PublicRoom;
  open: boolean;
  onToggle(next: boolean): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = room.log.slice(-60);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [room.log.length, open]);

  return (
    <>
      <button className={`dock-toggle${open ? ' on' : ''}`} onClick={() => onToggle(!open)} aria-label="牌桌记录">
        <IconLog size={20} />
      </button>

      <aside className={`dock${open ? ' open' : ''}`}>
        <div className="dock-head">
          <b>牌桌记录</b>
          <button className="dock-close" onClick={() => onToggle(false)} aria-label="收起">
            <IconClose size={15} />
          </button>
        </div>

        <div className="dock-body" ref={scroller}>
          {rows.length === 0 ? (
            <p className="dock-empty">牌局还没开始</p>
          ) : (
            rows.map((l) => (
              <div key={l.seq} className="log-row">
                <span>#{l.seq}</span>
                <p>{l.text}</p>
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
