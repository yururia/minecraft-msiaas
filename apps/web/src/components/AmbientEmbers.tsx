'use client';

import React, { useState, useEffect } from 'react';
import styles from './AmbientEmbers.module.css';

interface Ember {
  id: number;
  left: string;
  size: string;
  delay: string;
  duration: string;
  opacity: number;
  color: string;
  glow: string;
}

export default function AmbientEmbers() {
  const [embers, setEmbers] = useState<Ember[]>([]);

  useEffect(() => {
    const colors = [
      { color: '#a3d95d', glow: 'rgba(163, 217, 93, 0.5)' }, // Grass Green
      { color: '#ffcf40', glow: 'rgba(255, 207, 64, 0.5)' }, // Gold
      { color: '#ff5555', glow: 'rgba(255, 85, 85, 0.5)' },  // Redstone Red
      { color: '#55ffff', glow: 'rgba(85, 255, 255, 0.5)' }, // Diamond Aqua
    ];

    // Generate particles client-side only to prevent Next.js SSR hydration mismatches
    const generated: Ember[] = Array.from({ length: 24 }).map((_, i) => {
      const colorScheme = colors[Math.floor(Math.random() * colors.length)];
      return {
        id: i,
        left: `${Math.random() * 100}%`,
        size: `${Math.random() * 8 + 6}px`, // 6px to 14px
        delay: `${Math.random() * 8}s`,
        duration: `${Math.random() * 12 + 8}s`, // 8s to 20s
        opacity: Math.random() * 0.45 + 0.2, // 0.2 to 0.65 opacity
        color: colorScheme.color,
        glow: colorScheme.glow,
      };
    });
    setEmbers(generated);
  }, []);

  return (
    <div className={styles.container}>
      {embers.map((ember) => (
        <div
          key={ember.id}
          className={styles.ember}
          style={{
            left: ember.left,
            width: ember.size,
            height: ember.size,
            animationDelay: ember.delay,
            animationDuration: ember.duration,
            '--base-opacity': ember.opacity,
            '--ember-color': ember.color,
            '--ember-glow': ember.glow,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
