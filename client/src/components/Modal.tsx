import { useEffect, type ReactNode } from 'react';

export default function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="btrl-panel max-w-lg w-full max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--dark-gray)' }}
      >
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: '1px solid rgba(239,238,236,.08)' }}
        >
          <h2 className="font-display text-2xl lowercase text-off-white">{title}</h2>
          <button
            onClick={onClose}
            className="text-off-white/55 hover:text-off-white text-2xl leading-none"
          >
            &times;
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
