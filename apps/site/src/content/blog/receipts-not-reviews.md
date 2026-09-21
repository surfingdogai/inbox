---
title: Receipts, not reviews
description: Why a review is only valid against a co-signed receipt, why both sides reveal at once, and why a business reviews with an outcome code rather than stars.
date: 2026-09-21
author: Tiago Pita
cover: /art/tile-receipts.png
coverAlt: A pixel-art paper receipt with two seals and a signature
coverAnim: receipts
---

Reviews were supposed to be the memory of a market: who was good, who was not, so the next person could choose. They have become something else. A review today is a claim by someone who may or may not have been a customer, about a transaction that may or may not have happened, published on a platform whose incentive is volume. Businesses buy them, competitors plant them, and everyone has learned to read five stars as "probably fine" and one star as "probably angry". The signal is gone and the anxiety remains.

When agents start transacting on people's behalf, this gets worse rather than better. An agent can write a hundred plausible reviews before lunch. A business's agent can answer them. The one thing neither of them can fake is the transaction itself, if the transaction leaves a proof. So the network Surfing Dog Inbox will join, and any network that speaks the same open format, starts from a different primitive: not the review, but the receipt.

## The receipt

When an item in an inbox reaches a state that matters, a booking confirmed, an order paid, the instance issues a receipt: a small signed document that says these two parties agreed to this, at this time. It is signed with the instance's key, which the instance publishes in its manifest, so anyone can check it came from that business. Then the customer's side counter-signs it. Now both parties hold the same proof, and neither can produce it alone.

Everything else follows from that. A review is only accepted against a co-signed receipt. Not "verified purchase" as a badge a platform hands out; verified as in cryptographically tied to an event both sides signed. No receipt, no review. This is true in both directions: the business cannot rate a customer it never served, and the customer cannot rate a business it never dealt with.

It also means the network does not need to know much. It never sees what was ordered or said. It sees a receipt, two signatures and, later, two opinions. Content stays in the inbox where it belongs.

## Simultaneous reveal

The second rule is about timing. On most platforms the first review shapes the second: a business reads a complaint and replies defensively, or a customer sees a glowing response and softens. Some platforms let the business answer publicly; some let it "dispute" a review it does not like. Every one of those mechanisms turns a judgement into a negotiation.

Here, both sides write sealed. Each submission is a commitment, a hash the network stores, with the text held back. After a window, and the window is the same for both, everything submitted is revealed together. If one side never writes, the other side's review is still published when the window closes. If the business never even counter-signs the receipt, the customer's review publishes anyway once the hard deadline passes. Silence is not a veto.

Nobody writes in reaction to the other, and nobody gets to wait and see. The reviews are what each side actually thought, at the same moment, about the same event. That is the closest thing to a fair witness a network can offer.

## Why the business side is a code

The obvious symmetry would be to let businesses rate customers with stars too. That would be a mistake, and not only because a star is a bad unit of measurement. A person's rating follows them. A score that businesses "draw strongly on" when deciding whether to serve someone is, in European law, an automated decision about that person, with everything that implies. It is also the kind of thing that turns one bad afternoon into a lifetime of declined bookings.

So the business does not rate. It records an outcome: completed, no-show, cancelled late, refunded. A fact about what happened, drawn from the state machine that already knows it, not a feeling about the person. The network keeps these as decayed counts, so a no-show from two years ago matters less than one from last month, and it caps the weight of any single event. What a business gets back is advisory: a tier and some counts, never a pass or a fail, never a recommendation to decline. The decision stays with a human, the reason is recorded, and the person can contest it. Nothing here feeds credit, housing or employment, and nothing ever will.

## What this costs

It costs friction. Receipts have to be issued, counter-signed and stored. Windows have to pass before anyone reads anything. Some people will find it strange that they cannot review a place they only walked past.

I think the friction is the point. A review that costs nothing is worth nothing. A review tied to a receipt both sides signed, written blind and revealed at the same moment as the other side's, is worth reading. If we can make that ordinary, the star will go back to being what it was meant to be: a note from one person to the next, about something that really happened.

Receipts are next; the review service and the simultaneous reveal follow them. The formats are MIT so that anyone can run a network with the same rules.
