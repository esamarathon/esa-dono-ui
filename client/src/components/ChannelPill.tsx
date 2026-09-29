interface ChannelPillProps {
  label: string;
}

export default function ChannelPill({ label }: ChannelPillProps) {
  return (
    <span
      className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
      style={{
        background: 'rgba(239,238,236,.08)',
        color: 'var(--off-white)',
        opacity: 0.7,
      }}
    >
      {label}
    </span>
  );
}
