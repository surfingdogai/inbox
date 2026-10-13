---
title: Processing agreement
description: How we process your customers' personal data for you when we run your inbox (GDPR article 28).
eyebrow: Terms · hosted pilot
updated: 13 October 2026
order: 2
---

This agreement is part of the [hosted inbox terms](/hosted/terms/). It applies to the personal data your customers and your staff put into your hosted inbox. For that data you are the controller and we, Surfing Dog Lda, are your processor (GDPR article 28).

## 1. What we process

- **Subject:** running your inbox: receiving, storing and answering the requests, messages, bookings, orders and quotes that people and their agents send it, and the emails it sends about them.
- **Duration:** while you use the service, then the 30 days of read-only after you close it, then deletion (section 7).
- **Personal data:** what your customers send: names, email addresses, phone numbers, addresses, messages, what they book or order, amounts; the addresses of the people who sign in to your inbox; anything you type in.
- **Special categories:** not accepted during the pilot. Health and medical practices cannot use the hosted inbox yet. If a customer sends such data anyway, tell us, and do not ask for it.
- **People concerned:** your customers and the people who contact you, and your staff.

## 2. Your instructions

We process the data to run your inbox and for nothing else, on your instructions: these terms, your inbox's settings and what you ask us in writing. If a law requires us to do something else, we tell you before we do it, unless that law forbids it. If an instruction seems to break data protection law, we tell you at once.

## 3. Confidentiality

The people who run the service, and nobody else, can reach your inbox's data, and they are bound to keep it confidential. We do not read, analyse, sell, share or train any model on your customers' data. A network gets what your own settings send to it and nothing more, and none is on until you switch it on.

## 4. Security (article 32)

What is in place today, as it is:

- One database file per business. No other business's inbox can read yours.
- Encrypted connections from the visitor to our edge network, and from the edge network to our servers, where the edge checks our certificate. The edge network ends the visitor's connection and can see requests in transit.
- Secrets your inbox stores (connection credentials, webhook secrets, the key that signs receipts) are sealed with a key unique to your inbox, kept outside its database. Sign-in sessions, API keys and tokens are stored as hashes, never as they are.
- Outbound calls from your inbox (webhooks, for example) reach public addresses and never our own servers or private networks.
- Hourly backups, encrypted on our servers before they are stored anywhere else.
- The servers' disks are not encrypted during the pilot. That is why health and other special-category businesses wait.

## 5. Sub-processors

You authorise these sub-processors. Each is bound by the same duties, and we answer for them.

- **Our edge network.** Carries every request to and from your inbox (it ends the encrypted connection), delivers the email your inbox sends, and stores our encrypted backups. A company based in the United States, with servers worldwide.
- **The company that rents us our servers.** Runs the machines that hold your inbox's database. Where they are: see the [hosted terms](/hosted/terms/).

The companies are named in the copy of this agreement we send you when you confirm your inbox, and on request. We tell you by email at least 30 days before adding or replacing a sub-processor. You may object; if we cannot meet your objection, you may leave before the change, and download everything before you go.

## 6. Transfers outside the EU

Our edge network's company is in the United States. Transfers to it rely on the EU–US Data Privacy Framework or on standard contractual clauses in its data processing terms.

## 7. Helping you, breaches, and the end

- **People's rights.** Your inbox lets you export one customer's data and erase one customer. For anything it does not do, we help.
- **Breaches.** We tell you about a personal data breach that affects your inbox without undue delay, aiming for 24 hours, with what we know and what we are doing.
- **Your own assessments.** We give you what you need for a data protection impact assessment or a consultation with your authority.
- **At the end.** You can download everything at any time. 30 days after you close your inbox we delete it; backup copies are gone within 30 more days. We keep nothing else of your customers' data.
- **Proof.** On request we give you what you need to see that we keep this agreement, and allow one audit a year by you or an auditor you name, at your cost, with 30 days' notice and under confidentiality.

## 8. If this agreement and the terms disagree

On data protection, this agreement wins.
