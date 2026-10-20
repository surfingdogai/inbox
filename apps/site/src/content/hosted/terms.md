---
title: Hosted inbox terms
description: The terms for an inbox we run for you during the pilot, on your own domain.
eyebrow: Terms · hosted pilot
updated: 20 October 2026
order: 1
---

These terms are between Surfing Dog Lda, a company registered in Portugal ("we"), and the business that sets up a hosted inbox ("you"). They cover the hosted inbox during its pilot. The software itself is MIT-licensed, and this website and our other free services have their own [terms](/terms/).

## 1. What you get

- An instance of Surfing Dog Inbox that we run and keep up to date for you.
- While you set it up, it lives at a private address of ours (a generated name under `surfingdog.ai`). Nobody but you can open it there. It takes no requests from agents or people, is not listed anywhere, and asks search engines not to index it.
- It goes live at a hostname on your own domain (`inbox.yourbusiness.com` by default) once you have added the DNS record in section 2 and the certificate for that hostname is issued. From then on agents and people reach it, and it is listed on network.surfingdog.ai, which you can switch off in Settings → Networks, before it goes live too. Not before.
- The open-source inbox's features as they are when you use it. A feature that is described as coming is not part of these terms until it ships.

## 2. A domain of your own, and one DNS record

- You need a domain of your own: not an address on another company's platform domain.
- You add one DNS record (a CNAME) for the hostname you chose, pointing to the target we show you. The target is unique to your inbox. You add it yourself or have whoever runs your DNS add it.
- The record is how we know the domain is yours. Add it for a domain you control or are allowed to use for your business, and no other.
- Keep the record in place while you use the service. If it is removed or changed, agents can't reach your inbox at that name. Put it back within 72 hours and nothing else changes; after that your inbox stops taking requests from agents until the record is back. Putting it back is all it takes.
- One live inbox per domain. When an inbox goes live on a domain, any other inbox for the same domain that is not live yet is closed, and its owner is told.
- An inbox that is not live 30 days after you confirmed it is closed. We remind you before that, and you can ask once for 30 more days.

## 3. Price

- The hosted inbox is free during the pilot.
- From the start we count, each month, the requests customers and their AIs send your inbox and the bookings and orders it confirms. Spam and tests never count. Your account shows both, month by month.
- We will tell you by email at least 30 days before any charge, with the price. Nothing is charged without your agreement, and if you do not want to continue you can download everything and close before that date.

## 4. Where your data is, and backups

- Your inbox and its backups are stored in the European Union and nowhere else.
- Requests to your inbox pass through our edge network on their way. It ends the encrypted connection at one of its locations near the sender, which can be outside the European Union, and forwards each request to our servers over a new encrypted connection. To run and protect its network, it also keeps its own records of requests (addresses, times and the pages asked for), which can be kept outside the European Union.
- The email your inbox sends is delivered by the same provider, through the same network. It keeps a record of each email (sender, recipient, subject and whether it arrived) for about a month, and a list of addresses that bounced or reported mail as spam; these can be kept outside the European Union. The [processing agreement](/hosted/processing/) lists who processes what, and where.
- We back up every inbox every hour. Backups are encrypted on our servers, then stored in the European Union. If we have to restore your inbox, it goes back to its state at the last backup, at most one hour earlier; requests that arrived after it may be lost, and we tell you which hour it went back to.
- During the pilot we promise no uptime figure. We watch the service, tell you about outages that affect you, and say what happened.

## 5. Changes to how your inbox behaves

- An update that changes how rules or the starting presets behave reaches your inbox after we have told you about it by email, at least 15 days before, and not sooner.
- Changes to these terms: at least 15 days' notice by email, and at least 30 days for anything about price.
- A security fix may ship sooner. When it changes something you can see, we tell you what changed and why it could not wait.

## 6. Leaving, switching and closing

- **Download.** At any time, with a code sent to your address, you can download everything your inbox holds as one SQLite file that the open-source inbox opens: your items, messages, customers, services, hours, rules and settings. It can include the key that signs your receipts, in a file of its own, so an inbox you run yourself keeps signing as yours; keep that file as safe as a password. It leaves out sign-in sessions, API keys and the secrets your connections use; you set those up again where you go. Receipts your inbox already sent to a network stay with that network.
- **Switching.** To move to your own server, another provider or back to us, point your hostname at the new place. You can do it at any time, without notice. We charge nothing for downloading or switching, and we answer your questions about it.
- **Closing.** You can close your inbox at any time, with a code sent to your address. It then stays read-only for 30 days, and you can still download it. After that we delete it; copies in our backups are gone within 30 more days. The DNS record is yours: we tell you which one you may remove.
- **Ending the pilot.** We may end the pilot for everyone with 30 days' notice by email. You keep the download and the 30 days in every case.

## 7. Fair use, suspension and reports

- You agree to the [acceptable use rules](/hosted/acceptable-use/).
- If an inbox breaks them, or a report shows it is unlawful, we may suspend it: agents can no longer reach it, and you can still sign in, read what is there and download it. We tell you in writing what we did, why and how to ask us to look again. We close an inbox for this when the breach is serious and not otherwise, and we tell you why.
- Anyone can report an inbox: [how reports work](/hosted/reports/).

## 8. Personal data

- For the data your customers send to your inbox, you are the controller and we are your processor. The [processing agreement](/hosted/processing/) is part of these terms.
- For your own account (your address, your domain, how you use the service), we are the controller: [the hosted privacy notice](/hosted/privacy/).

## 9. Liability

- As far as the law allows, our total liability during the free pilot is at most €100, and neither of us is liable for indirect loss or lost profit.
- Nothing here limits liability that the law does not let us limit, such as for intent, gross negligence, death or personal injury.

## 10. Law

Portuguese law applies, and the courts of Portugal. We write to the address you signed up with; you write to hello@surfingdog.ai. Email counts as writing.
