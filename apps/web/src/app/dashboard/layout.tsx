'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './layout.module.css';
import AmbientEmbers from '../../components/AmbientEmbers';
import { PresetImportProvider } from '../../context/PresetImportContext';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const getNavItemClassName = (href: string) => {
    // Exact match for dashboard home, prefix match for others
    const isActive = href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname.startsWith(href);
    return `${styles.navItem} ${isActive ? styles.active : ''}`;
  };

  return (
    <PresetImportProvider>
      <div className={styles.container}>
        {/* 統一された影MOD風の光彩と粒子 */}
        <AmbientEmbers />
        <div className={styles.vignette} />

        <aside className={styles.sidebar}>
          <Link href="/" className={styles.logo} aria-label="SERVCRAFT">
            <span className={styles.logoPartLeft}>SERVCRAF</span>
            <span className={styles.logoPartRight}>T</span>
          </Link>
          <nav className={styles.nav}>
            <Link href="/dashboard" className={getNavItemClassName('/dashboard')}>
              ダッシュボード
            </Link>
            <Link href="/dashboard/presets" className={getNavItemClassName('/dashboard/presets')}>
              プリセット一覧
            </Link>
            <Link href="/dashboard/servers" className={getNavItemClassName('/dashboard/servers')}>
              サーバー監視
            </Link>
            <Link href="/dashboard/settings" className={getNavItemClassName('/dashboard/settings')}>
              サーバー設定
            </Link>
          </nav>
        </aside>
        <main className={styles.main}>
          {children}
        </main>
      </div>
    </PresetImportProvider>
  );
}
