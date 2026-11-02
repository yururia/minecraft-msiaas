import React from 'react';
import { GlassCard } from '../../components/GlassCard';
import { Button } from '../../components/Button';

export default function DashboardHome() {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
        <h2>ダッシュボード</h2>
        <Button variant="primary" href="/dashboard/presets/new">
          ＋ 新規プリセット作成
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.75rem' }}>
        <GlassCard variant="grass">
          <h3 style={{ marginBottom: '1.2rem', color: '#a3d95d', fontSize: '1.15rem', letterSpacing: '0.08em', fontWeight: 'bold' }}>
            現在の稼働サーバー
          </h3>
          <div style={{ fontSize: '3rem', fontWeight: 'bold', fontFamily: 'VT323, monospace', color: '#ffffff', letterSpacing: '0.05em' }}>
            0 / 1
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginTop: '1rem', gap: '0.5rem' }}>
            <span className="badge3d badge3dSuccess" style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}>
              ONLINE
            </span>
            <span style={{ color: '#a3d95d', fontSize: '0.9rem', fontFamily: 'Inter, sans-serif', fontWeight: '600' }}>
              利用可能です
            </span>
          </div>
        </GlassCard>

        <GlassCard variant="stone">
          <h3 style={{ marginBottom: '1.2rem', color: '#e5e7eb', fontSize: '1.15rem', letterSpacing: '0.08em', fontWeight: 'bold' }}>
            保存されたプリセット
          </h3>
          <div style={{ fontSize: '3rem', fontWeight: 'bold', fontFamily: 'VT323, monospace', color: '#ffffff', letterSpacing: '0.05em' }}>
            3
          </div>
          <p style={{ color: '#9ca3af', marginTop: '0.8rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
            最新: Create 1.20.1 Pack
          </p>
        </GlassCard>

        <GlassCard variant="wood">
          <h3 style={{ marginBottom: '1.2rem', color: '#f6ad55', fontSize: '1.15rem', letterSpacing: '0.08em', fontWeight: 'bold' }}>
            今月の利用可能時間
          </h3>
          <div style={{ fontSize: '2.8rem', fontWeight: 'bold', fontFamily: 'VT323, monospace', color: '#ffffff', letterSpacing: '0.05em' }}>
            730 HRS LEFT
          </div>
          <p style={{ color: '#f6ad55', marginTop: '0.8rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif', fontWeight: '500' }}>
            Freeプラン (Oracle Cloud)
          </p>
        </GlassCard>
      </div>
    </div>
  );
}




