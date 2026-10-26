import { useApp } from "../context";

/**
 * "A new version is ready" (lib/update.ts): one quiet line at the top of the inbox, while a newer
 * release is out. It opens the download page in the phone's browser, where the new version installs
 * over this one and keeps every connection.
 */
export function UpdateLine() {
  const { update } = useApp();
  if (update.kind === "none") return null;
  return (
    <a className={`update-line${update.kind === "required" ? " needed" : ""}`} href={update.page} rel="noopener">
      <span>
        {update.kind === "required"
          ? `This version is too old for your inbox. Get ${update.versionName} to keep it working.`
          : `A new version is ready: ${update.versionName}.`}
      </span>
      <b className="go">Get it</b>
    </a>
  );
}
