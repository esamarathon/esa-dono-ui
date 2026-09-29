import type { ReactNode } from 'react';

export default function Card({
  children,
  className = '',
  style,
  id,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
}) {
  return (
    <div id={id} className={`btrl-panel p-4 ${className}`} style={style}>
      {children}
    </div>
  );
}
