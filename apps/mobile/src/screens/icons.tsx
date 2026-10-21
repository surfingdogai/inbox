import type { ReactNode } from "react";

/** The design's line icons, drawn once (ADR-028). Each is decoration: the words beside it say what it is. */
function Icon({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width ?? 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const InboxIcon = () => (
  <Icon>
    <path d="M4 13l2.5-7h11L20 13v5H4z" />
    <path d="M4 13h5l1 2h4l1-2h5" />
  </Icon>
);

export const TodayIcon = () => (
  <Icon>
    <rect x="4" y="5" width="16" height="15" rx="3" />
    <path d="M8 3v4M16 3v4M4 10h16" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Icon>
);

export const ChevronDown = () => (
  <Icon width={2}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const ChevronLeft = () => (
  <Icon width={2}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon width={2.2}>
    <path d="M5 12l5 5 9-10" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon width={2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon width={2}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const OfflineIcon = () => (
  <Icon width={2}>
    <path d="M2 8.5a15 15 0 0 1 20 0" />
    <path d="M5.5 12a10 10 0 0 1 13 0" />
    <path d="M9 15.5a5 5 0 0 1 6 0" />
    <path d="M3 3l18 18" />
  </Icon>
);

/** The four corners of the camera frame. */
export const Corners = () => (
  <svg
    className="corners"
    viewBox="0 0 220 220"
    fill="none"
    stroke="#ffffff"
    strokeWidth={3}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M10 50V18a8 8 0 0 1 8-8h32" />
    <path d="M170 10h32a8 8 0 0 1 8 8v32" />
    <path d="M210 170v32a8 8 0 0 1-8 8h-32" />
    <path d="M50 210H18a8 8 0 0 1-8-8v-32" />
  </svg>
);

export const MoreIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);

/** The owner app's mark (apps/inbox/public/favicon.svg): a sunset half-disc over two ink lines. */
export const Mark = ({ size = 56 }: { size?: number }) => (
  <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="sdi-mark-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ff9650" />
        <stop offset="0.58" stopColor="#ff6fa8" />
        <stop offset="1" stopColor="#8a6bff" />
      </linearGradient>
      <clipPath id="sdi-mark-c">
        <path d="M4 36a28 28 0 0 1 56 0z" />
      </clipPath>
    </defs>
    <g clipPath="url(#sdi-mark-c)">
      <rect x="4" y="8" width="56" height="28" fill="url(#sdi-mark-g)" />
      <rect x="4" y="21" width="56" height="1.5" fill="var(--ground)" />
      <rect x="4" y="25" width="56" height="2" fill="var(--ground)" />
      <rect x="4" y="29.5" width="56" height="2.5" fill="var(--ground)" />
    </g>
    <path d="M8 44h48" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
    <path d="M14 52h36" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
  </svg>
);
