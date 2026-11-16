// Shared staff login card (#238): both the admin and moderator layouts render
// the same gate screen; only the title and the explanatory line differ, so the
// markup lives here and the layouts pass their role-specific copy.
import type { KeyboardEvent, ReactNode } from 'react';

interface StaffLoginCardProps {
  title: string;
  /** Role-specific explanatory line (admin vs moderator wording). */
  blurb: ReactNode;
  input: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string;
  placeholder: string;
}

export default function StaffLoginCard({
  title,
  blurb,
  input,
  onInput,
  onSubmit,
  pending,
  error,
  placeholder,
}: StaffLoginCardProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSubmit();
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="btrl-panel p-8 w-full max-w-sm">
        <h1 className="font-display text-3xl uppercase mb-4">{title}</h1>
        <p className="font-body text-sm text-off-white/55 mb-4">{blurb}</p>
        <input
          type="password"
          placeholder={placeholder}
          className="w-full px-3 py-2 mb-3 text-sm"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {error && (
          <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
            {error}
          </p>
        )}
        <button onClick={onSubmit} disabled={pending} className="btrl-button w-full">
          login
        </button>
      </div>
    </div>
  );
}
