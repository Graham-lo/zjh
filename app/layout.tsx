import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '好友炸金花',
  description: '2–6 人好友房间制炸金花，纯娱乐虚拟积分。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
