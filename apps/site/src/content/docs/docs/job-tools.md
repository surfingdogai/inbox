---
title: Job tools
description: Where a trade runs its jobs. Which job tools your Inbox will connect to, what a connection does, and what each needs.
---

A job tool is where a trade keeps its jobs, its quotes and its schedule. Connected, the requests you take on go into it, with their photos, and the visits scheduled in it take those times off what your Inbox offers for site visits.

Settings → Integrations → **Job tool**. Which requests go in: Settings → [Work](/docs/trades/#your-job-tool).

## Coming

Each of these is shown as **Soon** until its connection is released, and none is described as working before then.

| Tool | Connects with | What a request becomes | Its developer documentation |
| --- | --- | --- | --- |
| ServiceM8 | Your API key (Settings → API Keys) | A job in Quote status, with a client, a contact and the photos in the job diary | <https://developer.servicem8.com/docs/authentication> |
| Housecall Pro | Your API key (MAX plan) | A lead in your Job inbox (turn on its API Leads channel) | <https://docs.housecallpro.com/> |
| Fergus | A personal access token (admins; lasts a year) | An enquiry, with the photos and plans | <https://api.fergus.com/docs> |
| Jobber | Our Jobber app, once Jobber has reviewed it | A request on your request form | <https://developer.getjobber.com/docs> |

A tool that only connects through a partner programme (Jobber, and ServiceM8's one-click sign-in beside the API key) is shown as **Needs setup** until that is in place, with nothing to press.

## What a connection will do

- **Only the requests you choose.** By default, the ones you take on: when you quote one, or press **Send to …** on it. Never a test request.
- **Once.** A request is never in your tool twice: a second press, a retry or a lost answer finds the one already there.
- **Only what the job needs.** Who to answer, the site and how to find the way, what it is, when suits, the customer's words, and the photos where the tool takes files (ServiceM8, Fergus; a Housecall Pro lead links back to the request instead). Nothing goes to anyone else.
- **Your schedule, read.** Visits scheduled in your tool are busy times, read every few minutes; a change your tool announces is read at once.
- **Your hours, to start from.** ServiceM8 keeps your opening hours: Settings → Work → **Start from ServiceM8** shows them beside yours, and **Use these hours** makes them your Inbox's. Nothing changes until you press it, and hours kept in another time zone than your Inbox's are shown, not copied.
- **Your token, watched.** A Fergus token lasts a year; Settings → Work says when yours runs out, two weeks before.

## Building one

Every job tool is built from its published reference and checked against a local fake of it (`packages/adapters/test/fakes/work.ts`), never with a business's real key.
