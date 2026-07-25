import type { ReactNode } from 'react';

export default function Card({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`btrl-panel p-4 ${className}`} style={style}>
      {children}
    </div>
  );
}
