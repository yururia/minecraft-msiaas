'use client';

import React from 'react';
import Link from 'next/link';
import styles from './Button.module.css';
import { playClickSound } from '../lib/sound';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'classic';
  href?: string;
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({ 
  variant = 'primary', 
  href, 
  children, 
  className,
  onClick,
  ...props 
}) => {
  const combinedClassName = `${styles.button} ${styles[variant]} ${className || ''}`;

  const handleClick = (e: React.MouseEvent<any>) => {
    playClickSound();
    if (onClick) {
      onClick(e as any);
    }
  };

  if (href) {
    return (
      <Link href={href} className={combinedClassName} onClick={handleClick}>
        {children}
      </Link>
    );
  }

  return (
    <button className={combinedClassName} onClick={handleClick} {...props}>
      {children}
    </button>
  );
};
