import '../styles/globals.css';
import type { Metadata } from 'next';
import { Press_Start_2P } from 'next/font/google';
import { WindowHeader } from '../components/WindowHeader';

const pressStart2P = Press_Start_2P({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-press-start',
});

export const metadata: Metadata = {
  title: 'SERVCRAFT - ワンクリックMODサーバー構築',
  description: '複雑なMOD設定を自動化し、数分でマルチプレイ環境を構築できる次世代プラットフォーム。',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={pressStart2P.variable}>
      <body>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
          <WindowHeader />
          <main style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
