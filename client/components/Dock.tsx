import { useEffect, useRef, useState } from 'react';
import type { GameCommand, PublicRoom } from '../../shared/game.ts';
import { IconChat, IconClose, IconSend } from './Icons.tsx';

type Tab = 'chat' | 'log';

/** 右侧（手机上是底部抽屉）的聊天 + 牌桌记录。 */
export function Dock({
  room,
  cmd,
  open,
  onToggle,
  unread,
}: {
  room: PublicRoom;
  cmd(c: GameCommand): void;
  open: boolean;
  onToggle(next: boolean): void;
  unread: number;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, room.chat.length, room.log.length, open]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    cmd({ type: 'chat', text: body });
    setText('');
  };

  return (
    <>
      <button className={`dock-toggle${open ? ' on' : ''}`} onClick={() => onToggle(!open)} aria-label="聊天与记录">
        <IconChat size={20} />
        {unread > 0 && !open && <i className="badge">{unread > 9 ? '9+' : unread}</i>}
      </button>

      <aside className={`dock${open ? ' open' : ''}`}>
        <div className="dock-tabs">
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            聊天
          </button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
            牌桌记录
          </button>
          <button className="dock-close" onClick={() => onToggle(false)} aria-label="收起">
            <IconClose size={15} />
          </button>
        </div>

        <div className="dock-body" ref={scroller}>
          {tab === 'chat'
            ? room.chat.length === 0
              ? <p className="dock-empty">还没有人说话</p>
              : room.chat.map((m) => (
                  <div key={m.seq} className={`chat-row${m.playerId === room.viewerId ? ' mine' : ''}`}>
                    <span className="chat-av">{m.avatar}</span>
                    <div>
                      <b>{m.name}</b>
                      <p>{m.text}</p>
                    </div>
                  </div>
                ))
            : room.log
                .slice(-60)
                .map((l) => (
                  <div key={l.seq} className="log-row">
                    <span>#{l.seq}</span>
                    <p>{l.text}</p>
                  </div>
                ))}
        </div>

        {tab === 'chat' && (
          <div className="dock-input">
            <input
              value={text}
              maxLength={80}
              placeholder="说点什么…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
            />
            <button className="btn tiny send" onClick={send} aria-label="发送">
              <IconSend size={15} />
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
