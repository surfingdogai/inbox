import type { ReactNode } from "react";

/** The design's line icons, drawn once (ADR-026). Each is decoration: the words beside it say what it is. */
function Icon({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <svg
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
