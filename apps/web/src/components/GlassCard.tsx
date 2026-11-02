import React from 'react';
import styles from './GlassCard.module.css';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  interactive?: boolean;
  variant?: 'stone' | 'grass' | 'wood';
}

export const GlassCard: React.FC<GlassCardProps> = ({ 
  children, 
  interactive = false,
  variant = 'stone',
  className,
  ...props 
}) => {
  const classNames = [
    styles.card,
    styles[variant],
    interactive ? styles.interactive : '',
    className || ''
  ].filter(Boolean).join(' ');

  return (
    <div className={classNames} {...props}>
      {children}
    </div>
  );
};

