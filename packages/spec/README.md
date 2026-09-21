# @surfingdog/spec (MIT)

The open formats of Surfing Dog Inbox, so anyone can implement a compatible instance, agent,
or review service:

- the discovery manifest (`/.well-known/…`, see ADR-002),
- the receipt format (compact JWS, Ed25519) and its counter-signature,
- the review payload and verification rules,

each with JSON Schema (generated from the Zod schemas here) and test vectors in `vectors/`.
The Go network service consumes the same vectors in its tests.
