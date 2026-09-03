import { useState } from 'react';
import { AVATARS } from '../../shared/game.ts';
import type { Identity } from './Landing.tsx';

/**
 * 坐下之后再改名字和头像。
 *
 * 首页那一屏本来就能选样子，但进了房间就锁死了 —— 随手起的「牌友3271」打了两把
 * 想换个名字，唯一的办法是退房重进，桌上其他人还得等他。引擎里 `rename` 一直都在，
 * 缺的只是一个能点开的入口。
 *
 * 两处同时更新：一是发 `rename` 命令，让这张桌子上的人立刻看到新名字（服务端
 * 落盘到账户，换房间、隔天再来都还是这个名字）；二是写回本机的身份缓存，
 * 让下次开新房时的默认值也跟着变，不然改了名字下一把又变回去。
 *
 * 什么时候都能改：名字和头像是自己怎么被称呼，不是牌桌状态，没有理由挑时候。
 */
export function ProfileDialog({
  name,
  avatar,
  onSave,
  onIdent,
  onClose,
}: {
  name: string;
  avatar: string;
  onSave(next: Identity): void;
  onIdent?(next: Identity): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<Identity>({ name, avatar });
  const trimmed = draft.name.trim();
  const dirty = trimmed !== name || draft.avatar !== avatar;

  const submit = () => {
    if (!trimmed || !dirty) return onClose();
    const next = { name: trimmed.slice(0, 10), avatar: draft.avatar };
    onSave(next);
    onIdent?.(next);
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <h3>改名 · 换头像</h3>
        <p className="modal-note">改完这一桌的人马上就能看到，下次进来也还是这个名字</p>

        <div className="avatar-grid" role="radiogroup" aria-label="选择头像">
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={draft.avatar === a}
              className={`avatar-opt${draft.avatar === a ? ' on' : ''}`}
              onClick={() => setDraft((d) => ({ ...d, avatar: a }))}
            >
              {a}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="profile-nick">
          昵称
        </label>
        <input
          id="profile-nick"
          className="text-input"
          autoFocus
          value={draft.name}
          maxLength={10}
          placeholder="让朋友一眼认出你"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!trimmed || !dirty} onClick={submit}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
