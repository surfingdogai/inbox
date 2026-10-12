# ADR-004 — Owner authentication in-house; the instance is its own OAuth 2.1 server

**Status:** accepted (21 Sep 2026)

## Decision
- Owner sign-in: an **email with a link and a six-digit code**, either of which signs in once, then
  hashed **DB sessions**, roles owner and staff. No passwords, and no better-auth. (Amended 12 Oct
  2026, below.)
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
official Workers page. Our surface is small and must be identical on D1, DO SQLite and
`node:sqlite`. MCP 2026-07-28 deprecated dynamic registration
in favour of CIMD; Claude and ChatGPT both prefer CIMD, Copilot still uses DCR, Gemini's consumer
app cannot connect custom servers, Grok needs admin provisioning.

## Consequences
We own the auth code and its tests. The AS sits behind an interface so a library could replace it.

## Sign-in hardened (12 Oct 2026)

What a link in an email does when it is opened, and what reaches a log, changed:

- **Opening a link changes nothing.** Mail scanners open every link in an email, and a link that
  signed in on a GET was used up before the owner got to it. A sign-in link now opens a page with a
  button, and only the POST it sends signs in, from this inbox's own page. The same holds for the
  links that confirm or undo an address change.
- **A code beside the link.** The sign-in email carries a six-digit code too, for an email read on
  another device. It works once, for 15 minutes, and stops after five wrong tries; an address gets
  at most twenty tries a day and a few emails at once, then one a minute, counted alike whether or
  not it is known here.
- **No link or code in a log outside development.** When a send fails, the log says why and the
  page says "Couldn't send". Only an instance with no address to send from at all writes the
  whole email to its log, as before.
- **The session cookie is `__Host-sdi_session`** over https: this host only, https only, set for
  every path, never with a domain. The plain `sdi_session` is used only over http (localhost, or a
  server with no TLS yet), and ignored over https, except for a session made before this change:
  that one still signs in under the plain name until it ends, and moves to `__Host-sdi_session` the
  next time the owner app loads (`/auth/me`), so an upgrade signs nobody out. Whether a request
  came over https is read with `INBOX_PUBLIC_URL` first, as the cookie was set.
- **A handoff** (`createHandoff`): a host that has just confirmed an owner's address itself signs
  them in with a token that works once, for a minute, at that host only, by the same page and POST.
- **Changing the owner's address** needs a step-up code sent to the current address, and a link
  to the new one, confirmed in a browser signed in as that owner. The old address is then told, with
  a link that puts it back for seven days and signs out every session. A host is told through
  `onOwnerEmailChange`; a server's operator can run `set-owner-email` instead. The same step-up
  helper (`sendStepUp`, `checkStepUp`) guards a download, and anything else that moves an inbox away
  from its owner.
