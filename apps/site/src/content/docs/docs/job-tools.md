---
title: Job tools
description: Where a trade runs its jobs. Which job tools your Inbox connects to, what a connection does, and what each needs.
---

A job tool is where a trade keeps its jobs, its quotes and its schedule. Connected, the requests you take on go into it, with their photos, and the visits scheduled in it take those times off what your Inbox offers for site visits.

Settings → Integrations → **Job tool**. Which requests go in: Settings → [Work](/docs/trades/#your-job-tool).

## Which tools

ServiceM8 connects with your own key today. Housecall Pro and Fergus connect with yours too, once the server you are on has cleared their API terms for this use; until then they show **Needs setup**. Jobber, and ServiceM8's one-click sign-in, show **Needs setup** until their partner app is on the server. Nothing to press shows a button that goes nowhere.

| Tool | Connects with | What a request becomes | Its developer documentation |
| --- | --- | --- | --- |
| ServiceM8 | Your API key (Settings → API Keys) | A job in Quote status, with a client, a contact and the photos in the job diary | <https://developer.servicem8.com/docs/authentication> |
| Housecall Pro | Your API key (MAX plan) | A lead in your Job inbox (turn on its API Leads channel) | <https://docs.housecallpro.com/> |
| Fergus | A personal access token (admins; lasts a year) | An enquiry, with the photos and plans | <https://api.fergus.com/docs> |
| Jobber | A Jobber app reviewed by Jobber, on the server | A request on your request form | <https://developer.getjobber.com/docs> |

On your own server: `JOB_TOOLS_CLEARED=housecallpro,fergus` once you have read their terms; `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` and `JOBBER_API_VERSION` (the version your Jobber app was checked against) for Jobber, whose webhooks go to `/v1/hooks/jobber/app`; `SERVICEM8_CLIENT_ID` and `SERVICEM8_CLIENT_SECRET` for ServiceM8's sign-in.

## What a connection does

- **Only the requests you choose.** By default, the ones you take on: when you quote one, or press **Send to …** on it. Never a test request.
- **Once.** A request is never in your tool twice: a second press, a retry or a lost answer finds the one already there.
- **Only what the job needs.** Who to answer, the site and how to find the way, what it is, when suits, the customer's words, and the photos where the tool takes files (ServiceM8, Fergus; a Housecall Pro lead links back to the request instead). Nothing goes to anyone else.
- **Your schedule, read.** Visits scheduled in your tool are busy times, read every few minutes; a change your tool announces is read at once.
- **Your hours, to start from.** ServiceM8 keeps your opening hours: Settings → Work → **Copy opening hours from ServiceM8** shows them beside yours, and **Use these hours** makes them your Inbox's. Nothing changes until you press it, and hours kept in another time zone than your Inbox's are shown, not copied.
- **One job each.** With **Every request**, each request becomes a ServiceM8 job, and ServiceM8 may charge for the jobs it makes.
- **Your token, watched.** A Fergus token lasts a year; Settings → Work says when yours runs out, two weeks before.

## Building one

Every job tool is built from its published reference and checked against a local fake of it (`packages/adapters/test/fakes/work.ts`), never with a business's real key.
