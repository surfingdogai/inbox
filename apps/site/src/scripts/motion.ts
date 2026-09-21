/**
 * Motion. One mechanism, four utilities, no dependencies.
 *
 * The contract this implements:
 *  - Everything meant to be read is visible when the page loads. Only elements
 *    that are BELOW the fold when this runs are ever armed, so the first still
 *    frame of the page is the finished page.
 *  - The resting state of every element is the normal, visible one. This script
 *    adds a class to arm it; armed is opacity .55, never 0, so a failed observer
 *    still leaves readable text.
 *  - prefers-reduced-motion arms nothing.
 *  - No IntersectionObserver, no motion; the page is simply finished already.
 *
 * Authoring:
 *  data-reveal             this element rises into place when it comes into view
 *  data-reveal="stagger"   this element's direct children follow one another
 *  class="u-line"          the four-colour brand line draws itself once
 *  class="u-count" data-to="1240"   the number counts up to its final value once
 *  class="u-breathe"       pure CSS, no script; the sun only
 */

const ARMED = "reveal-armed";
const IN = "reveal-in";
const LINE_ARMED = "line-armed";
const LINE_DRAWN = "line-drawn";

/** A generous fold: anything starting in the last slice of the first screen
 *  counts as below it, because it is not what a screenshot shows. */
const foldOf = () => window.innerHeight * 0.9;

const isBelowFold = (el: Element, fold: number) => el.getBoundingClientRect().top >= fold;

function run(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const fold = foldOf();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        play(el);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.01 },
  );

  /* --- reveals ---------------------------------------------------- */
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
    if (!isBelowFold(el, fold)) return;

    if (el.dataset.reveal === "stagger") {
      const children = Array.from(el.children) as HTMLElement[];
      if (!children.length) return;
      children.forEach((child, i) => {
        child.classList.add(ARMED);
        child.style.setProperty("--reveal-i", String(Math.min(i, 8)));
      });
      el.dataset.revealGroup = "true";
    } else {
      el.classList.add(ARMED);
    }
    observer.observe(el);
  });

  /* --- the brand line --------------------------------------------- */
  document.querySelectorAll<HTMLElement>(".u-line").forEach((el) => {
    if (!isBelowFold(el, fold)) return;
    el.classList.add(LINE_ARMED);
    observer.observe(el);
  });

  /* --- counters ---------------------------------------------------- */
  document.querySelectorAll<HTMLElement>(".u-count").forEach((el) => {
    if (!el.dataset.to) return;
    if (!isBelowFold(el, fold)) return;
    // Hold the finished text; the count writes over it and puts it back.
    el.dataset.countFinal = el.textContent ?? "";
    observer.observe(el);
  });

  /* Safety: if something never intersects (a hidden tab, a stalled observer),
     un-arm it so nothing is left sitting at .55 opacity. */
  window.setTimeout(() => {
    document.querySelectorAll<HTMLElement>(`.${ARMED}:not(.${IN})`).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add(IN);
    });
  }, 4000);

  function play(el: HTMLElement): void {
    if (el.dataset.revealGroup === "true") {
      for (const child of Array.from(el.children)) child.classList.add(IN);
      return;
    }
    if (el.classList.contains(ARMED)) el.classList.add(IN);
    if (el.classList.contains(LINE_ARMED)) el.classList.add(LINE_DRAWN);
    if (el.classList.contains("u-count")) countUp(el);
  }
}

/**
 * Count up to data-to, once. The final text is already in the HTML, so the
 * animation borrows the element for a moment and hands it back exactly as it
 * was: any prefix, suffix, separator or decimal survives untouched.
 */
function countUp(el: HTMLElement): void {
  const to = Number(el.dataset.to);
  if (!Number.isFinite(to)) return;

  const final = el.dataset.countFinal ?? el.textContent ?? "";
  const from = Number(el.dataset.from ?? 0);
  const decimals = (el.dataset.to ?? "").split(".")[1]?.length ?? 0;
  const match = final.match(/[\d][\d.,\s]*/);
  const head = match ? final.slice(0, match.index ?? 0) : "";
  const tail = match ? final.slice((match.index ?? 0) + match[0].length) : "";
  const grouped = match ? /[,\s]/.test(match[0]) : false;
  const format = (n: number) =>
    n.toLocaleString("en-GB", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouped,
    });

  const duration = 900;
  const start = performance.now();

  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Ease out, so it arrives rather than stops.
    const eased = 1 - (1 - t) ** 3;
    el.textContent = head + format(from + (to - from) * eased) + tail;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = final;
  };

  el.textContent = head + format(from) + tail;
  requestAnimationFrame(step);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run, { once: true });
} else {
  run();
}

export {};
