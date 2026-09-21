# ADR-004 — Owner authentication in-house; the instance is its own OAuth 2.1 server

**Status:** accepted (21 Sep 2026)

## Decision
- Owner sign-in: **passkeys** (`@simplewebauthn/server` 14, pure JS over Web Crypto) plus **magic
  link**, hashed **DB sessions**, roles owner and staff. No better-auth.
- Owner API and owner MCP: the instance runs a **minimal OAuth 2.1 authorization server** (~400
  lines): RFC 9728 protected-resource metadata, RFC 8414 server metadata, PKCE S256, **Client ID
  Metadata Documents** first, dynamic client registration (RFC 7591) as fallback, refresh-token
  rotation, one consent screen, opaque hashed tokens, scopes `inbox:read inbox:write
  catalogue:write availability:write settings:read settings:write setup:run offline_access`.
- **API keys** (`sdi_own_…`, hashed, scoped) for clients that only send headers. Both flow through
  one bearer resolver; tools never know which.
- A "Connect your AI" wizard step shows the MCP URL, per-client instructions (Claude: Settings →
  Connectors → custom connector; Claude Code: `claude mcp add`; ChatGPT: developer-mode connector;
  Cursor/VS Code deep links) and the API-key fallback, with a live "last call from client X" check.

## Why
better-auth 1.7 is 203 KB gzipped with Kysely inside, has no Durable Object adapter and no
official Workers page, and its passkey plugin pins SimpleWebAuthn 13. Our surface is small and must
be identical on D1, DO SQLite and `node:sqlite`. MCP 2026-07-28 deprecated dynamic registration
in favour of CIMD; Claude and ChatGPT both prefer CIMD, Copilot still uses DCR, Gemini's consumer
app cannot connect custom servers, Grok needs admin provisioning.

## Consequences
We own the auth code and its tests. The AS sits behind an interface so a library could replace it.
