# ADR-046 — A business's look: its logo, a theme and an accent

**Status:** accepted, 1 November 2026. The request and its two answers are the founder's: the look
reaches the owner app and everything a customer sees (the emails sent to them, the pages behind their
links, the inbox's public page), and there are four themes, Standard, Minimal, Dark and Warm, each with
an accent the owner picks from a short palette. No migration: the look lives in the settings document,
and the logo in the tables request files already use.

## Context

A customer only ever sees the business. Until now every inbox looked the same: the business's name
in text over the same black and white page, and every email plain text. A business wants its own
mark and its own colour on what its customers open, without that turning into a design tool, and
without the owner's assistant, or a message written to it, being able to change what every customer
sees.

## Decisions

1. **One look per inbox, as a setting.** `settings.look` is `{theme, accent, logo}`: a theme of four,
   an accent of seven (Ink, Blue, Teal, Green, Violet, Plum, Ochre), and a pointer to the logo or
   null. The default (Standard, Ink, no logo) is the look as it was: a default inbox's pages are the
   same byte for byte, its emails stay text alone, and its owner app is unchanged. The palette is
   plain data (`@surfingdog/core/look`), read by the server and the owner app alike. Settings → Look
   chooses with swatches and dots, never a typed colour.
2. **Every accent passes AA, and none is red.** Each has a day tone with a white label and a night
   tone with a dark one; each passes 4.5:1 as text on every ground it sits on and as a button's label,
   in all four themes (`look-palette.test.ts`). Red says something went wrong, and nothing else, so no
   accent lies within 30° of it. Ink is not a colour of its own: it is the theme's own ink.
3. **The look is the owner's in person.** `look` is in `OWNER_ONLY_SETTINGS`: the owner's AI and an
   integration key are refused, so a customer's message can never get the owner's assistant to
   restyle what customers see. The logo changes only through its own door
   (`PUT`/`DELETE /v1/owner/look/logo`): a settings write that touches `look.logo` is refused from
   anyone, so the settings never name a file that is not there, or someone else's.
4. **The logo lives in the inbox's own database.** A PNG, JPEG or WebP of up to 512 KB and 16 to 2048
   pixels a side, told by its first bytes (never its name or its Content-Type), kept as one `blobs`
   row of kind `logo` with its chunks: the same store as request files, on every runtime, with no
   bucket and no migration. Everyone sees it, so only what draws the picture is kept (a strict list
   per format) and every other block goes, Content Credentials (C2PA) and blocks of a maker's own
   among them: they can name who made it, or carry thumbnails of what it was made from. A request's
   files keep their own, shorter list. Nothing that sweeps, counts or erases request files touches
   it. A downloaded copy of the inbox keeps it.
5. **Customers load it from `/p/logo/<sha16>.<ext>`.** The name is the first 16 of its SHA-256, so a
   new picture is a new address: it is kept a year (`immutable`), and an old one is simply not found.
   It sits under the public page's door, so it takes that door's limit and reaches exactly as far: on
   a hosted inbox, only at the business's own name once it is live, as its `/c/` links. A page's
   policy allows images from its own address and nowhere else (`img-src 'self'`). The owner app reads
   it through `/v1/owner/look/logo`, which works before the inbox is live and with a key.
6. **Pages take the theme; emails stay light.** A customer's page takes the theme's tones, the
   accent's buttons, links and focus ring, and the logo above the name, which stays the text. On a
   dark page (Dark, or Standard on a dark device) the logo sits on a small white plate, as in
   Settings and in the owner app at night: most logos are drawn in dark ink. A page inside the
   business's own website (`?embed=1`) takes the theme and accent, not the header. An error or
   "too many" page takes the look too, and the default when the look cannot be read. An email gets an
   HTML part only once the look is chosen, written from the final text (the text stays the email, and
   the only part the mail log keeps): the logo or the name, on a light page whatever the theme, since
   a mail app that darkens a dark email again turns it odd. Only the inbox's own answer links
   (`<public address>/c/<token>`, whole) are thin buttons in the accent; every other address, a name
   a stranger typed into the form among them, stays a link that shows all of itself. Inline styles
   only, no web font, no script. The owner's own emails stay text.
7. **In the owner app, the owner's own Day or Night still wins.** The business's theme decides only
   what the switch's third choice turns into: System, as before, while the theme is Standard; Auto,
   following the theme, once another is chosen. The accent colours the app's buttons, links and
   focus ring.

## Not decided here

- Whether the logo goes into what agents read (the profile, the manifest, a stay's JSON-LD): a spec
  change and a published fact. Not for now.
- Whether an inbox that never chooses a look sends HTML too. Not for now: text, as before.
- The logo on the owner's sign-in page, which would need it on `GET /v1/business`. The Sun stays.
- A second logo for dark pages, for a business whose logo is drawn in white: until then it sits on
  the white plate, where a white logo does not show.
