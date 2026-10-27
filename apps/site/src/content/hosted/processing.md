---
title: Processing agreement
description: How we process your customers' personal data for you when we run your inbox (GDPR article 28).
eyebrow: Terms · hosted pilot
updated: 18 October 2026
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

The people who run the service, and nobody else, can reach your inbox's data, and they are bound to keep it confidential. We do not read, analyse, sell, share or train any model on your customers' data. On Pro, the spam filters' AI check reads a new sender's masked message to sort it, for your inbox and for nothing else. Your inbox joins network.surfingdog.ai, which lists your business in its directory, the day it goes live; a network gets what Settings → Networks says it is sent and nothing more, and you can switch any network off there at any time, before your inbox goes live too.

## 4. Security (article 32)

What is in place today, as it is:

- One database file per business. No other business's inbox can read yours.
- Encrypted connections from the visitor to our edge network, and from the edge network to our servers, where the edge checks our certificate. The edge network ends the visitor's connection and can see requests in transit.
- Secrets your inbox stores (connection credentials, webhook secrets, the key that signs receipts) are sealed with a key unique to your inbox, kept outside its database. Sign-in sessions, API keys and tokens are stored as hashes, never as they are.
- Outbound calls from your inbox (webhooks, for example) reach public addresses and never our own servers or private networks.
- Hourly backups, encrypted on our servers before they are stored anywhere else, and stored in the European Union.
- The servers' disks are not encrypted during the pilot. That is why health and other special-category businesses wait.

## 5. Sub-processors

You authorise these sub-processors. Each is bound by the same duties, and we answer for them.

- **Our edge network.** Carries every request to and from your inbox (it ends the encrypted connection, at one of its locations near the sender), delivers the email your inbox sends, and keeps its own records of both (section 6). It also stores our encrypted backups; those are in the European Union. A company based in the United States, with servers worldwide.
- **The company that rents us our servers.** Runs the machines that hold your inbox's database. Where they are: see the [hosted terms](/hosted/terms/).
- **Anthropic, for the spam filters' AI check (Pro).** Reads the opening message of someone your inbox has not dealt with before, with email addresses, phone numbers and bank and card numbers taken out and links cut to their domain, and answers whether it is a sales pitch, a scam or junk. It does not train its models on it, and deletes it within 30 days, unless its safety checks flag it (then it may keep it up to two years) or the law requires keeping it. A company based in the United States.

The companies are named in the copy of this agreement we send you when you confirm your inbox, and on request. We tell you by email at least 30 days before adding or replacing a sub-processor. You may object; if we cannot meet your objection, you may leave before the change, and download everything before you go.

## 6. Where the data stays, and transfers outside the EU

Your inbox and its backups are stored in the European Union and nowhere else: the database on our servers, and its encrypted backups.

Apart from what you send elsewhere yourself (webhooks, connections and networks you switch on, and the email your inbox writes to your customers) and, on Pro, what the spam filters' AI check reads (below), what can pass outside the European Union is what travels through our edge network: requests to and from your inbox, and the email your inbox sends, on their way. Its locations around the world carry them; they are not where your inbox is kept.

The edge network also keeps its own records, which can be kept outside the European Union:

- of requests to your inbox: addresses, times and the pages asked for, to run and protect its network;
- of the email your inbox sends: sender, recipient, subject and whether it arrived, for about a month, and a list of addresses that bounced or reported mail as spam.

Mail you write to our addresses is kept in our mailbox at an email company, which may store it outside the European Union. Do not send us your customers' personal data by email: to ask about one customer, name the item in your inbox, and to hand data over, use your inbox's export.

Our edge network's company is in the United States. Transfers to it rely on the EU–US Data Privacy Framework or on standard contractual clauses in its data processing terms.

With Pro's spam filters on, the masked opening message of someone new goes to Anthropic, in the United States, to be read. That transfer relies on the standard contractual clauses in Anthropic's data processing terms.

## 7. Helping you, breaches, and the end

- **People's rights.** Your inbox lets you export one customer's data and erase one customer. For anything it does not do, we help.
- **Breaches.** We tell you about a personal data breach that affects your inbox without undue delay, aiming for 24 hours, with what we know and what we are doing.
- **Your own assessments.** We give you what you need for a data protection impact assessment or a consultation with your authority.
- **At the end.** You can download everything at any time. 30 days after you close your inbox we delete it; backup copies are gone within 30 more days. We keep nothing else of your customers' data.
- **Proof.** On request we give you what you need to see that we keep this agreement, and allow one audit a year by you or an auditor you name, at your cost, with 30 days' notice and under confidentiality.

## 8. If this agreement and the terms disagree

On data protection, this agreement wins.
