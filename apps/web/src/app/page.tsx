'use client';

import React from 'react';
import styles from './page.module.css';
import { Button } from '../components/Button';
import IsometricBlock3d from '../components/IsometricBlock3d';
import AmbientEmbers from '../components/AmbientEmbers';
import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className={styles.container}>
      {/* 影MOD風の新緑の光彩（Ambient Embers） */}
      <AmbientEmbers />

      {/* Cinematic Vignette Overlay */}
      <div className={styles.vignette} />

      <div className={styles.contentWrapper}>
        {/* Main Hero Header Section */}
        <header className={styles.hero}>
          <div className={styles.logoContainer}>
            <h2 className={styles.logoText} aria-label="SERVCRAFT">
              <span className={styles.logoPartLeft}>SERVCRAF</span>
              <span className={styles.logoPartRight}>T</span>
            </h2>
          </div>
          <div className={styles.badgeWrapper}>
            <span className="badge3d badge3dGold" style={{ fontSize: '0.85rem', padding: '0.35rem 1rem' }}>
              PREMIUM SERVICE PLATFORM
            </span>
          </div>
          <p className={styles.subtitle}>
            複雑なMODの依存関係、サーバーの仕分け、セキュリティ設定をすべて自動化。<br />
            あなたが「遊びたいMODを選ぶだけ」で、最高のマルチプレイ環境を瞬時に構築します。
          </p>
        </header>

        {/* Real functional features showcase matching the mockup aesthetics */}
        <div className={styles.featureGrid}>
          {/* Card 1: Server Provisioning */}
          <div className={styles.glassCardWrapper}>
            <div className={`${styles.glassCard} ${styles.cardEmerald}`}>
              <div className={styles.blockContainer}>
                <Link href="/dashboard" aria-label="ダッシュボードを開く">
                  <IsometricBlock3d type="grass" size={110} />
                </Link>
              </div>
              <div className={styles.cardContent}>
                <span className={styles.cardLabel}>SERVER STATUS</span>
                <h3 className={styles.cardTitle}>サーバー起動・監視</h3>
                <p className={styles.cardDesc}>
                  Oracle Cloud / AWS APIと直結した10分以内の超高速プロビジョニング。プレイヤー不在時は20分で自動終了し無駄なコストを徹底削減します。
                </p>
                <div style={{ marginTop: 'auto', paddingTop: '1.5rem' }}>
                  <Button href="/dashboard" variant="primary" style={{ width: '100%', justifyContent: 'center' }}>
                    ダッシュボードを開く
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Preset / Mod Management */}
          <div className={styles.glassCardWrapper}>
            <div className={`${styles.glassCard} ${styles.cardRedstone}`}>
              <div className={styles.blockContainer}>
                <Link href="/dashboard/presets" aria-label="プリセットを管理する">
                  <IsometricBlock3d type="stone" size={110} />
                </Link>
              </div>
              <div className={styles.cardContent}>
                <span className={styles.cardLabel}>MOD CONFIGURATION</span>
                <h3 className={styles.cardTitle}>プリセット＆MOD管理</h3>
                <p className={styles.cardDesc}>
                  共通対応バージョンと前提MODを自動解析。サーバー・クライアント完全分離配信や、手持ちのZIPファイル読み込みインポートにも完全対応。
                </p>
                <div style={{ marginTop: 'auto', paddingTop: '1.5rem' }}>
                  <Button href="/dashboard/presets" variant="secondary" style={{ width: '100%', justifyContent: 'center' }}>
                    プリセットを管理する
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: Secure Connection & Account Settings */}
          <div className={styles.glassCardWrapper}>
            <div className={`${styles.glassCard} ${styles.cardDiamond}`}>
              <div className={styles.blockContainer}>
                <Link href="/dashboard/settings" aria-label="アカウント設定を開く">
                  <IsometricBlock3d type="obsidian" size={110} />
                </Link>
              </div>
              <div className={styles.cardContent}>
                <span className={styles.cardLabel}>SECURITY & PROFILE</span>
                <h3 className={styles.cardTitle}>アカウント・セキュア接続</h3>
                <p className={styles.cardDesc}>
                  Cloudflare Tunnelによるポート開放不要のP2P暗号化接続。Minecraft UUID連携によるホワイトリスト制御で荒らし対策も万全です。
                </p>
                <div style={{ marginTop: 'auto', paddingTop: '1.5rem' }}>
                  <Button href="/dashboard/settings" variant="classic" style={{ width: '100%', justifyContent: 'center' }}>
                    アカウント設定へ
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
