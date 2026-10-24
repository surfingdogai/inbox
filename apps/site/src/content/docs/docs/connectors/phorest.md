---
title: Phorest
description: A salon's Phorest, its own credentials. Start from its services, staff and rosters; offer its free times; each booking written to Phorest first, confirmed here only once Phorest took it. Not available yet.
sidebar:
  order: 10
---

**Status: not available yet.** The code is complete and switched off until we have confirmed with Phorest that a salon's own API access may be used by a tool like this one. Until then the card says so, and nothing connects.

## What it does

- **Start from Phorest.** Your branch's services you offer online (with each stylist's own price, else their level's, and their own length), your staff (those hidden from online booking are left out) and a week of their rosters as their hours. You keep what you want, one press each. A second read updates what the first made. A branch that names no currency, or a price in another currency than yours, comes in unpriced, for you to price.
- **Phorest's own times.** Agents are offered the times Phorest says are free, with who is free then, asked of Phorest once a minute at most. When Phorest cannot say (it asks to slow down, does not answer, or answers with times that cannot be read), your Inbox's own times are offered, and the write still decides.
- **Written first.** A booking for a service that came from Phorest is written to Phorest, as your own client, before anything is promised, and only when the time is free here too. Phorest took it: it is confirmed here. Phorest would not: it waits for you, nothing promised. No answer: your Inbox looks for it among that client's appointments that day before deciding anything, and settles it within minutes. Meanwhile no rule and no AI confirms it, and when you confirm one yourself, it is written to Phorest first. Phorest took one that cannot be confirmed here after all: it is cancelled in Phorest again, and you are told.
- **Cancelled here, cancelled there.** A move is made in Phorest.

It sends Phorest only what a booking needs: the service, the stylist, the time, and your client's name, email and phone. No card and no payment ever goes to Phorest: deposits are paid on your own Stripe or Mollie.

## What you need

Ask Phorest's support team for API access, from the email address your business uses in Phorest, with your Phorest account number ([Phorest's guide](https://developer.phorest.com/docs/getting-started.md)). They send a username starting `global/`, a password and your business ID. Choose **Phorest · Europe** or **Phorest · Americas & Australia**, as Phorest asks, then your branch.

The password is encrypted before it is stored, and never shown again, to you or to your AI.
