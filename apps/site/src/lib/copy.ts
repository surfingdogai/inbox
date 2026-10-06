/**
 * Copy buttons, as a progressive enhancement: what they copy is already on the page, readable and
 * selectable, so a button only appears where the clipboard is there to use. Each button keeps its
 * own resting label (read once, never at click time), a second click restarts its timer rather than
 * stacking another, and the result is spoken through one polite live region shared by the page.
 */
const RESET_MS = 1600;

let region: HTMLElement | null = null;
function announce(message: string): void {
  if (!region) {
    region = document.createElement("span");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "status");
    // Visually hidden, still read.
    region.style.cssText =
      "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0";
    document.body.append(region);
  }
  // Clear first so the same words twice in a row are announced twice.
  region.textContent = "";
  window.setTimeout(() => {
    if (region) region.textContent = message;
  }, 50);
}

export function wireCopyButtons(selector = "[data-copy]"): void {
  if (!navigator.clipboard) return;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(selector))) {
    const label = button.textContent?.trim() || "Copy";
    let timer = 0;
    button.hidden = false;
    button.addEventListener("click", async () => {
      const value = button.dataset.copy;
      if (!value) return;
      window.clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
        announce("Copied");
      } catch {
        button.textContent = "Select it instead";
        announce("Could not copy. Select the text instead.");
      }
      timer = window.setTimeout(() => {
        button.textContent = label;
      }, RESET_MS);
    });
  }
}
