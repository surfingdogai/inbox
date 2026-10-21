/**
 * Whether a switch in the host's environment is on: `1`, `true`, `yes` or `on`, in any case. Every
 * switch of the inbox reads this way (INBOX_DEMO, INBOX_UCP_LODGING), on both runtimes.
 */
export function flagOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}
