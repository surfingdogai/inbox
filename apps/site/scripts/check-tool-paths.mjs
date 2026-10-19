/**
 * Before the site is deployed: every free tool's address it links (src/lib/i18n.ts TOOLS, in every
 * language) must answer 200 on the live site, since the tools are the network's pages and this site
 * only links them. A tool whose page is not out yet fails here, and the site waits for it.
 *
 *   node scripts/check-tool-paths.mjs                      against https://surfingdog.ai
 *   node scripts/check-tool-paths.mjs https://example.test another address
 *
 * Node reads src/lib/i18n.ts as TypeScript from 23.6 on (on Node 22, add --experimental-strip-types).
 */
import { LANGS, TOOL_IDS, TOOLS } from "../src/lib/i18n.ts";

const base = (process.argv[2] ?? "https://surfingdog.ai").replace(/\/+$/, "");
const paths = [...new Set(TOOL_IDS.flatMap((t) => LANGS.map((l) => TOOLS[t][l])))];
let failed = 0;
for (const p of paths) {
  let status = 0;
  try {
    const res = await fetch(base + p, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    status = res.status;
    await res.body?.cancel();
  } catch {
    status = 0;
  }
  if (status !== 200) failed++;
  console.log(`${status === 200 ? "ok  " : "FAIL"} ${status || "---"} ${p}`);
}
console.log(`${paths.length - failed} of ${paths.length} answer 200 on ${base}`);
process.exit(failed ? 1 : 0);
