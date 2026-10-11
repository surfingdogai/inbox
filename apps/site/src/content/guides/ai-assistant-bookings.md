## What an assistant needs

Someone asks their assistant to book a haircut for Saturday morning, a table for four, or a service for their bike. To finish the job rather than hand back a link, the assistant needs four things from you:

- **Your free times**, as an answer to "is Saturday at 10 free?", not a picture of your opening hours.
- **A way to book** that answers straight away: booked, not available, or here is another time.
- **A way to change or cancel** later, so plans that move don't turn into a phone call or a no-show.
- **Your terms in words**: deposit, cancellation, no-show. Assistants read them before they commit their person.

A booking page, a form or an email address is made for people. An assistant with a browser can sometimes get through one, but it can't count on it, and our check doesn't count it.

<h2 id="platforms">If your bookings run through a platform</h2>

Many businesses take bookings through a platform: a salon or clinic system, a restaurant reservations service, a scheduling tool. The platform's page is made for people, and a link to it from your site isn't a door an assistant can use.

Some assistants already book through a few large platforms directly. Google's AI Mode, for example, has worked with platforms such as OpenTable, Resy, Tock and Booksy for reservations ([reported in 2025](https://siliconangle.com/2025/08/21/google-opens-ai-mode-globally-personalized-agentic-capabilities/)). Ask your platform whether it offers an agent door your customers' assistants can use, and if it does, link that door from your own site, so an assistant that reads your site can find it.

A platform's tool for managing your own calendar is a different thing: it's a door for you, not for your customers.

<h2 id="memberships">Sign-ups and memberships</h2>

Gyms, classes, courses, clubs and newsletters take a sign-up rather than a booking. The same idea holds: a door that signs a person up for your own service, and later lets them pause, resume or end it. Logging in is not signing up, and isn't counted.

## What counts in the check

We read what your own site and its doors declare, and never book anything. For bookings, these count:

- **Book**: a tool or an operation that makes a booking, such as `create_booking`, `book_table`, `create_reservation`, `reserve` or `POST /bookings`. Also an agent inbox that takes bookings, and a booking platform's agent door that you declare when you claim your listing.
- **Free times**: `check_availability`, `get_availability`, `list_slots`.
- **Change**: `reschedule_booking`, `update_booking`, `change_reservation`, `PATCH /bookings/{id}`.
- **Cancel**: `cancel_booking`, `DELETE /bookings/{id}`.
- **Sign up**: `sign_up`, `register`, `create_account`, `enrol`, `register_for_class`, `join_membership`, `subscribe_newsletter`, or a schema.org `RegisterAction` or `JoinAction`.
- **Membership**: `pause_membership`, `resume_membership`, `cancel_membership`, `update_membership`, `cancel_subscription`.

Not counted: a booking link, a form, email, phone, a chat widget, or anything that logs in.

Once an assistant can book with you, changing, cancelling and free times count toward your score too. So the biggest step is usually all four together, on one MCP server or in one API document.
