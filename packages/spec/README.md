# @surfingdog/spec (MIT)

The open formats of Surfing Dog Inbox, so anyone can implement a compatible instance, agent,
or review service:

- the discovery manifest (`/.well-known/…`, see ADR-002),
- the receipt format (compact JWS, Ed25519) and its counter-signature,
- the review payload and verification rules,

each with JSON Schema (generated from the Zod schemas here) and test vectors in `vectors/`.
The Go network service consumes the same vectors in its tests.

`vectors/receipts.json` is the receipt file: fixed keys (the issuer is RFC 8037's published
Ed25519 test key), the `sub` derivation, two receipts whose JWS any implementation must reproduce
exactly, one valid acknowledgement, and the refusals with the error each must raise. Regenerate
with `npx tsx scripts/gen-receipt-vectors.ts` from `packages/core`; `receipts-vectors.test.ts`
there checks the file against the code on both runtimes.
