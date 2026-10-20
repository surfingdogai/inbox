---
title: Phorest
description: A salon's Phorest, its own credentials. Start from its services, staff and rosters; offer its free times; each booking written to Phorest first, confirmed here only once Phorest took it. Needs setup.
sidebar:
  order: 10
---

**Status: needs setup.** The code is complete and switched off until we have confirmed with Phorest that a salon's own API access may be used by a tool like this one. Until then the card says *Needs setup: ask Phorest for API access for your salon*, and nothing connects.

## What it does

- **Start from Phorest.** Your branch's services (with each stylist's own price and length), your staff (those hidden from online booking are left out) and a week of their rosters as their hours. You keep what you want, one press each. A second read updates what the first made.
- **Phorest's own times.** Agents are offered the times Phorest says are free, with who is free then. When Phorest cannot say (it asks to slow down, or does not answer), your Inbox's own times are offered, and the write still decides.
- **Written first.** A booking for a service that came from Phorest is written to Phorest, as your own client, before anything is promised. Phorest took it: it is confirmed here. Phorest would not: it waits for you, nothing promised. No answer: your Inbox looks for it among that client's appointments that day before deciding anything, and settles it within minutes.
- **Cancelled here, cancelled there.** A move is made in Phorest.

It sends Phorest only what a booking needs: the service, the stylist, the time, and your client's name, email and phone. No card and no payment ever goes to Phorest: deposits are paid on your own Stripe or Mollie.

## What you need

Ask Phorest's support team for API access, from the email address your business uses in Phorest, with your Phorest account number ([Phorest's guide](https://developer.phorest.com/docs/getting-started.md)). They send a username starting `global/`, a password and your business ID. Choose **Phorest (Europe)** or **Phorest (Americas, Australia)**, as Phorest asks, then your branch.

The password is encrypted before it is stored, and never shown again, to you or to your AI.
