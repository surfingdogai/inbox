/**
 * Writes the network protocol's vectors and JSON Schemas into packages/spec (ADR-017 §7.4):
 *
 *   vectors/signatures.json, vectors/passes.json, vectors/receipts-v2.json   from ./network-vectors.ts
 *   schemas/<name>.json                                                      from @surfingdog/spec's JSON_SCHEMAS
 *
 * Run from packages/core, then format:
 *
 *   npx tsx scripts/gen-network-vectors.ts && npx biome format --write ../spec/vectors ../spec/schemas
 *
 * `test/network-vectors.test.ts` rebuilds everything on both runtimes and fails when a committed
 * file differs. vectors/scoring.json and vectors/ordering.json are the network's, copied unchanged.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSON_SCHEMAS, jsonSchemaOf } from "@surfingdog/spec";
import { buildNetworkVectors } from "./network-vectors";

const spec = path.resolve(import.meta.dirname, "../../spec");
const write = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const v = await buildNetworkVectors();
write(path.join(spec, "vectors/signatures.json"), v.signatures);
write(path.join(spec, "vectors/passes.json"), v.passes);
write(path.join(spec, "vectors/receipts-v2.json"), v.receiptsV2);

const dir = path.join(spec, "schemas");
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith(".json")) rmSync(path.join(dir, f));
for (const name of Object.keys(JSON_SCHEMAS)) write(path.join(dir, `${name}.json`), jsonSchemaOf(name));

console.log(
  `signatures: ${v.signatures.requests.length} requests, ${v.signatures.forwarded.length} forwarded; ` +
    `passes: ${v.passes.parse.length} strings, ${v.passes.emails.length} emails; ` +
    `receipts-v2: ${v.receiptsV2.receipts.length} receipts, ${v.receiptsV2.refused_receipts.length} refused; ` +
    `schemas: ${Object.keys(JSON_SCHEMAS).length}`,
);
