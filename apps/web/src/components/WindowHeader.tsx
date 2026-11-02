'use client';

import React, { useEffect, useState } from 'react';

export function WindowHeader() {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    // プリロードスクリプトが公開した electronAPI が存在するか確認
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      setIsElectron(true);
    }
  }, []);

  if (!isElectron) return null; // ブラウザ表示時は非表示にして完璧な互換性を確保

  const handleMinimize = () => {
    (window as any).electronAPI.minimize();
  };

  const handleMaximize = () => {
    (window as any).electronAPI.maximize();
  };

  const handleClose = () => {
    (window as any).electronAPI.close();
  };

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      height: '32px',
      background: 'rgba(18, 20, 26, 0.92)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      padding: '0 1rem',
      userSelect: 'none',
      WebkitAppRegion: 'drag', // ウィンドウのドラッグ移動を有効化
      fontFamily: 'Inter, sans-serif',
      fontSize: '0.78rem',
      color: '#9ca3af',
      position: 'relative',
      zIndex: 9999,
    } as any}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <img 
          src="/images/icon.jpg" 
          alt="ServCraft Icon" 
          style={{ 
            width: '20px', 
            height: '20px', 
            borderRadius: '4px',
            border: '1px solid rgba(16, 185, 129, 0.4)' 
          }} 
        />
        <span style={{ fontWeight: '600', letterSpacing: '0.05em', color: '#ffffff' }}>
          SERVCRAFT Client
        </span>
      </div>

      <div style={{
        display: 'flex',
        gap: '0.4rem',
        WebkitAppRegion: 'no-drag', // ボタン部分はドラッグをオフにしてクリックを有効化
      } as any}>
        {/* 最小化ボタン */}
        <button 
          onClick={handleMinimize}
          style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            width: '28px',
            height: '24px',
            cursor: 'pointer',
            fontSize: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
        >
          ‐
        </button>
        {/* 最大化ボタン */}
        <button 
          onClick={handleMaximize}
          style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            width: '28px',
            height: '24px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
        >
          ⬜
        </button>
        {/* 閉じるボタン */}
        <button 
          onClick={handleClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            width: '28px',
            height: '24px',
            cursor: 'pointer',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            transition: 'background 0.2s, color 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#ef4444';
            e.currentTarget.style.color = '#ffffff';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
            e.currentTarget.style.color = '#9ca3af';
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
