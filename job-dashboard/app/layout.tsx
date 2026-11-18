import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: '취업 상황판' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
