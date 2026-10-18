/**
 * Platform answers for the calendar connectors' contract tests (ADR-020). They are written after the
 * platforms' published documentation and the RFCs' own examples (RFC 4791 for CalDAV, RFC 6764 for
 * discovery, Cal.com's API v2 reference, Google Calendar API v3), in the shapes those servers answer
 * with, including the quirks that matter here: iCloud's partition host, Nextcloud's well-known
 * redirect, a server that does not expand repeating events. No test calls a real account.
 */

export const ICLOUD_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/</href>
    <propstat>
      <prop>
        <current-user-principal><href>/123456789/principal/</href></current-user-principal>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat>
      <prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"/><displayname/></prop>
      <status>HTTP/1.1 404 Not Found</status>
    </propstat>
  </response>
</multistatus>`;

export const ICLOUD_HOME_SET = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/123456789/principal/</href>
    <propstat>
      <prop>
        <calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav">
          <href xmlns="DAV:">https://p42-caldav.icloud.com:443/123456789/calendars/</href>
        </calendar-home-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

export const ICLOUD_CALENDARS = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">
  <response>
    <href>/123456789/calendars/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/123456789/calendars/home/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Home</displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>
        <CS:getctag>HwoQEgwAAAh</CS:getctag>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/123456789/calendars/work/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Salon &amp; Work</displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/123456789/calendars/family/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Family</displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        <current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/123456789/calendars/tasks/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Reminders</displayname>
        <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/123456789/calendars/inbox/</href>
    <propstat>
      <prop><resourcetype><collection/><C:schedule-inbox/></resourcetype></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

/** An expanded calendar-query: each occurrence a VEVENT in UTC with its RECURRENCE-ID, as RFC 4791 §9.6.5 says. */
export function icloudReport(events: readonly { href: string; ics: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${events
  .map(
    (e) => `  <response>
    <href>${e.href}</href>
    <propstat>
      <prop><getetag>"e-${e.href.length}"</getetag><C:calendar-data><![CDATA[${e.ics}]]></C:calendar-data></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>`,
  )
  .join("\n")}
</multistatus>`;
}

export const EVENT_DENTIST = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Apple Inc.//iOS 18.0//EN\r
BEGIN:VEVENT\r
UID:7E4F1C2A-0B8D-4C31-9F1E-3A2B1C0D9E8F\r
DTSTAMP:20261020T090000Z\r
DTSTART:20261103T100000Z\r
DTEND:20261103T110000Z\r
SUMMARY:Dentist\r
END:VEVENT\r
END:VCALENDAR\r
`;

/** A weekly class in Lisbon time, Tuesdays and Thursdays, with one week skipped and one moved: unexpanded. */
export const EVENT_WEEKLY_LISBON = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp//Calendar 1.0//EN
BEGIN:VTIMEZONE
TZID:Europe/Lisbon
BEGIN:STANDARD
DTSTART:19961027T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19960331T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:yoga-weekly@example.com
DTSTART;TZID=Europe/Lisbon:20261020T180000
DTEND;TZID=Europe/Lisbon:20261020T190000
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T235959Z
EXDATE;TZID=Europe/Lisbon:20261105T180000
SUMMARY:Yoga
END:VEVENT
BEGIN:VEVENT
UID:yoga-weekly@example.com
RECURRENCE-ID;TZID=Europe/Lisbon:20261110T180000
DTSTART;TZID=Europe/Lisbon:20261110T200000
DTEND;TZID=Europe/Lisbon:20261110T210000
SUMMARY:Yoga (late)
END:VEVENT
END:VCALENDAR
`;

export const EVENT_ALLDAY_FREE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:birthday@example.com
DTSTART;VALUE=DATE:20261103
DTEND;VALUE=DATE:20261104
SUMMARY:Mum's birthday
END:VEVENT
END:VCALENDAR
`;

export const EVENT_ALLDAY_BUSY = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:closed@example.com
DTSTART;VALUE=DATE:20261104
DTEND;VALUE=DATE:20261105
TRANSP:OPAQUE
SUMMARY:Salon closed for training
END:VEVENT
END:VCALENDAR
`;

export const EVENT_CANCELLED_AND_FREE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:cancelled@example.com
DTSTART:20261103T140000Z
DTEND:20261103T150000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:free@example.com
DTSTART:20261103T160000Z
DTEND:20261103T170000Z
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
`;

/** An Outlook-style zone name with a long folded description, as Exchange writes it. */
export const EVENT_OUTLOOK = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Microsoft Exchange Server 2010
BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E00800000000
DTSTART;TZID=W. Europe Standard Time:20261103T090000
DTEND;TZID=W. Europe Standard Time:20261103T093000
SUMMARY:Supplier call about the new colour range and the delivery that is late
 r than we hoped
END:VEVENT
END:VCALENDAR
`;

export const NEXTCLOUD_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/</d:href>
  <d:propstat>
   <d:prop>
    <d:current-user-principal><d:href>/remote.php/dav/principals/users/ana/</d:href></d:current-user-principal>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

export const NEXTCLOUD_HOME_SET = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/principals/users/ana/</d:href>
  <d:propstat>
   <d:prop><cal:calendar-home-set><d:href>/remote.php/dav/calendars/ana/</d:href></cal:calendar-home-set></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

export const NEXTCLOUD_CALENDARS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/calendars/ana/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/ana/personal/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Personal</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:current-user-privilege-set/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

/* --- Cal.com API v2 -------------------------------------------------------- */

export const CALCOM_ME = {
  status: "success",
  data: {
    id: 4417,
    uuid: "f6a4f7b2-0d65-4c5c-a3e3-1d2f2a1a9b10",
    username: "ana-salon",
    name: "Ana's Salon",
    email: "ana@salon.example",
    timeZone: "Europe/Lisbon",
    weekStart: "Monday",
    locale: "pt",
    defaultScheduleId: 10,
    organizationId: null,
  },
};

export const CALCOM_EVENT_TYPES = {
  status: "success",
  data: [
    { id: 101, title: "Haircut", slug: "haircut", lengthInMinutes: 60, lengthInMinutesOptions: [], hidden: false },
    { id: 102, title: "Quick trim", slug: "trim", lengthInMinutes: 30, hidden: false },
    { id: 103, title: "Colour", slug: "colour", lengthInMinutes: 90, lengthInMinutesOptions: [90, 120], hidden: true },
  ],
};

export function calcomBookings(
  bookings: readonly {
    uid: string;
    start: string;
    end: string;
    status: string;
    metadata?: Record<string, string>;
  }[],
  nextCursor: string | null = null,
) {
  return {
    status: "success",
    data: bookings.map((b, i) => ({
      id: 9000 + i,
      uid: b.uid,
      title: "Booking",
      start: b.start,
      end: b.end,
      status: b.status,
      metadata: b.metadata ?? {},
      eventType: { id: 101, slug: "haircut" },
      attendees: [{ name: "Someone", timeZone: "Europe/Lisbon", language: "pt", absent: false }],
      createdAt: "2026-10-01T10:00:00Z",
    })),
    pagination: { nextCursor, hasMore: nextCursor !== null },
  };
}

export const CALCOM_CALENDARS = {
  status: "success",
  data: {
    connectedCalendars: [
      {
        integration: { name: "Google Calendar", type: "google_calendar", slug: "google-calendar" },
        credentialId: 77,
        primary: {
          externalId: "ana@gmail.com",
          integration: "google_calendar",
          name: "ana@gmail.com",
          primary: true,
          readOnly: false,
          email: "ana@gmail.com",
          isSelected: true,
          credentialId: 77,
        },
        calendars: [
          {
            externalId: "ana@gmail.com",
            integration: "google_calendar",
            name: "ana@gmail.com",
            primary: true,
            readOnly: false,
            email: "ana@gmail.com",
            isSelected: true,
            credentialId: 77,
          },
          {
            externalId: "holidays@group.v.calendar.google.com",
            integration: "google_calendar",
            name: "Holidays",
            primary: false,
            readOnly: true,
            isSelected: false,
            credentialId: 77,
          },
        ],
      },
    ],
    destinationCalendar: {
      id: 5,
      integration: "google_calendar",
      externalId: "ana@gmail.com",
      primaryEmail: "ana@gmail.com",
      userId: 4417,
      eventTypeId: null,
      credentialId: 77,
    },
  },
};

/* --- Google ------------------------------------------------------------------ */

export const GOOGLE_TOKEN = {
  access_token: "ya29.a0-test-access",
  expires_in: 3599,
  refresh_token: "1//0g-test-refresh",
  scope: "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned",
  token_type: "Bearer",
};

export const GOOGLE_PROBE = { summary: "ana.salon@gmail.com", timeZone: "Europe/Lisbon" };
