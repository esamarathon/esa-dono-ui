// Minimal inline stroke-icon set for the admin/moderator sidebars. Kept as
// plain hand-drawn SVGs (no icon library dependency) — 20x20 viewBox,
// 1.5 stroke width, currentColor so they inherit the nav link's text color.
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(children: ReactNode, props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return base(
    <>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1" />
    </>,
    props,
  );
}

export function UsersIcon(props: IconProps) {
  return base(
    <>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M3.5 17c0-3.038 2.91-5.5 6.5-5.5s6.5 2.462 6.5 5.5" />
    </>,
    props,
  );
}

export function GiftIcon(props: IconProps) {
  return base(
    <>
      <rect x="3" y="8" width="14" height="9" rx="1" />
      <path d="M3 8h14M10 8v9M10 8c-1.2-3-3-4-4-3.2-1 .8-.2 3.2 4 3.2ZM10 8c1.2-3 3-4 4-3.2 1 .8.2 3.2-4 3.2Z" />
    </>,
    props,
  );
}

export function PollIcon(props: IconProps) {
  return base(
    <>
      <path d="M4 17V9M10 17V3M16 17v-6" />
    </>,
    props,
  );
}

export function GoalIcon(props: IconProps) {
  return base(
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.5" />
      <circle cx="10" cy="10" r="0.75" fill="currentColor" />
    </>,
    props,
  );
}

export function ReceiptIcon(props: IconProps) {
  return base(
    <>
      <path d="M5 2.5h10v15l-2-1.2-1.5 1.2-1.5-1.2-1.5 1.2-1.5-1.2-2 1.2v-15Z" />
      <path d="M7 6.5h6M7 9.5h6M7 12.5h4" />
    </>,
    props,
  );
}

export function ClipboardIcon(props: IconProps) {
  return base(
    <>
      <rect x="4.5" y="3.5" width="11" height="14" rx="1" />
      <path d="M7.5 3.5V2.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75V3.5" />
      <path d="M7 8.5h6M7 11.5h6M7 14.5h4" />
    </>,
    props,
  );
}

export function BanIcon(props: IconProps) {
  return base(
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M5 5l10 10" />
    </>,
    props,
  );
}

export function PlayIcon(props: IconProps) {
  return base(
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M8.5 7l5 3-5 3V7Z" fill="currentColor" stroke="none" />
    </>,
    props,
  );
}

export function CheckBadgeIcon(props: IconProps) {
  return base(
    <>
      <path d="M10 2.5l1.9 1 2.1-.4 1 1.9 1.9 1-.4 2.1 1 1.9-1.9 1 .4 2.1-1.9 1-1 1.9-2.1-.4-1.9 1-1.9-1-2.1.4-1-1.9-1.9-1 .4-2.1-1-1.9 1.9-1-.4-2.1 1.9-1 1-1.9 2.1.4 1.9-1Z" />
      <path d="M7.2 10.2l1.8 1.8 3.8-3.8" />
    </>,
    props,
  );
}

export function ChevronsLeftIcon(props: IconProps) {
  return base(
    <>
      <path d="M12.5 4.5 6.5 10l6 5.5M8 4.5 2 10l6 5.5" />
    </>,
    props,
  );
}

export function ChevronsRightIcon(props: IconProps) {
  return base(
    <>
      <path d="M7.5 4.5 13.5 10l-6 5.5M12 4.5 18 10l-6 5.5" />
    </>,
    props,
  );
}

export function LogoutIcon(props: IconProps) {
  return base(
    <>
      <path d="M8 17H4.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H8" />
      <path d="M13 14l4-4-4-4M17 10H7" />
    </>,
    props,
  );
}
