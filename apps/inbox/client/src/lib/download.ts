/**
 * Saving a file the inbox answered with, as pure functions where they can be: the name comes from
 * the answer's `Content-Disposition` (`attachment; filename="…"`), and only a plain name is taken,
 * no path, else `fallback`.
 */
export function attachmentName(header: string | null, fallback: string): string {
  const name = /filename="([^"]+)"/.exec(header ?? "")?.[1];
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

/** Hands a file to the browser to save. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
