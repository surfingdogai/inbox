/**
 * The open network protocol's primitives (ADR-017 §2, §2.4, §7): the strings a person holds, email
 * normalisation, and RFC 9421 request signatures. Pure and web-standard, so they run unchanged on
 * every runtime; `packages/spec/vectors/` holds them to the network's implementation.
 */
export * from "./credentials";
export * from "./email";
export * from "./httpsig";
export * as sf from "./sfv";
