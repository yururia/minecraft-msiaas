'use client';

import React from 'react';
import styles from './IsometricBlock3d.module.css';

interface IsometricBlock3dProps {
  type?: 'grass' | 'stone' | 'obsidian';
  size?: number; // Size in px, default is 100
}

export default function IsometricBlock3d({ type = 'grass', size = 100 }: IsometricBlock3dProps) {
  const customStyle = {
    '--size': `${size}px`,
    '--half-size': `${size / 2}px`,
    '--neg-half-size': `-${size / 2}px`,
  } as React.CSSProperties;

  const blockClass = `${styles.scene} ${styles[type]}`;

  return (
    <div className={blockClass} style={customStyle}>
      <div className={styles.cubeWrapper}>
        <div className={styles.cube}>
          <div className={`${styles.face} ${styles.top}`} />
          <div className={`${styles.face} ${styles.bottom}`} />
          <div className={`${styles.face} ${styles.front}`} />
          <div className={`${styles.face} ${styles.back}`} />
          <div className={`${styles.face} ${styles.left}`} />
          <div className={`${styles.face} ${styles.right}`} />
        </div>
      </div>
    </div>
  );
}
