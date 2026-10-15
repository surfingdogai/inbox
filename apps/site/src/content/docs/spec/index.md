---
title: Specs
description: Open specs for agent-ready businesses — what an AI agent can do at a business, the agent inbox manifest, receipts and the census — each versioned, with JSON Schemas and test vectors.
---

Four specs, each with a version, a changelog, JSON Schemas and test vectors anyone can test against. The specs and the code are MIT. The census's counts are open data under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

| Spec | Version | Last changed |
| --- | --- | --- |
| [What an AI agent can do at a business](/spec/capabilities/) | version 2 | 15 October 2026 |
| [Agent inbox manifest](/spec/manifest/) | surfingdog-inbox/0 | 12 October 2026 |
| [Receipts](/spec/receipts/) | claims version 2 | 27 September 2026 |
| [The census of what AI agents can do](/spec/census/) | method version 1 | 15 October 2026 |

## Check yours

[Paste a manifest, a receipt or an acknowledgement](/spec/check/) to see whether it holds to these specs, and if not, why. The check runs in your browser and sends nothing anywhere.

## For machines

- [`/spec/index.json`](/spec/index.json) lists every spec, its version and its files.
- [`/spec/capabilities.json`](/spec/capabilities.json) is the latest capability vocabulary. Each version stays at its own address: [`/spec/capabilities/v1.json`](/spec/capabilities/v1.json), [`/spec/capabilities/v2.json`](/spec/capabilities/v2.json).
- `/spec/schemas/<name>.json` is every JSON Schema, such as [`manifest.json`](/spec/schemas/manifest.json). A schema's `$id` is its address.
- `/spec/vectors/<name>.json` is every set of test vectors, such as [`receipts-v2.json`](/spec/vectors/receipts-v2.json). An implementation is right when it agrees with them.
- `/spec/vocab/<name>.json` is every vocabulary: door types, categories, door report classes.

The same files, with Zod schemas and the conformance check as code (`checkManifest`, `checkReceipt`, `checkAcknowledgement`), are in [`packages/spec`](https://github.com/surfingdogai/inbox/tree/main/packages/spec).

## How they change

- New fields and values are added. Nothing is renamed, and every version stays published.
- A reader ignores a field it does not know.
- A change that would break a reader comes with a new version: `surfingdog-inbox/1`, receipt claims `ver: 3`, vocabulary version 3.
- Each spec says what changed, and when, in its changelog.
