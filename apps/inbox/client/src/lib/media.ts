import { useCallback, useSyncExternalStore } from "react";

/** The one breakpoint: below 900px the inbox is a single column with a bottom action bar. */
export const PHONE_QUERY = "(max-width: 899px)";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
