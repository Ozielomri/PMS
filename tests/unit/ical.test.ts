/**
 * CAL-09 / CAL-10: ICS parser, normalisation into listing-local nights, generator and the
 * guarded feed fetcher. No network: fetch and DNS are stubbed.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptSecret } from "@/lib/crypto/secrets";
import { fetchFeed, FeedFetchError } from "@/lib/ical/fetch";
import { buildIcs, exportUid, foldLine, mergeBusyNights } from "@/lib/ical/generate";
import { normalizeEvents, zonedTimeToUtc } from "@/lib/ical/normalize";
import { IcalParseError, parseContentLine, parseIcs, unfoldLines } from "@/lib/ical/parse";
import { syncFeed } from "@/lib/ical/sync";
import { exportUrl, feedUrlDisplay, feedUrlHash, isExportToken, newExportToken, tokenFromSegment } from "@/lib/ical/urls";

const CRLF = "\r\n";
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR"].join(CRLF) + CRLF;
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

const AIRBNB = ics(
  "CALSCALE:GREGORIAN",
  ...vevent("DTEND;VALUE=DATE:20261210", "DTSTART;VALUE=DATE:20261205", "UID:1418fb94e984-a1b2c3d4e5f6@airbnb.com", "SUMMARY:Reserved",
    "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEF\\nPhone Number (Last 4 Digits): 1234"),
  ...vevent("DTEND;VALUE=DATE:20270105", "DTSTART;VALUE=DATE:20261228", "UID:7f3e1b2a-0000@airbnb.com", "SUMMARY:Airbnb (Not available)"),
);

const VRBO = [
  "BEGIN:VCALENDAR",
  "PRODID:-//HomeAway.com, Inc.//EN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:6789-abcd@homeaway.com",
  "DTSTAMP:20261120T100000Z",
  "DTSTART;VALUE=DATE:20261215",
  "DTEND;VALUE=DATE:20261218",
  "SUMMARY:Reserved - Ann Example",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n"); // bare LF line ends, as some feeds send

describe("unfoldLines / parseContentLine", () => {
  it("unfolds continuation lines (space or tab) and accepts CRLF and LF", () => {
    expect(unfoldLines("A:1\r\nDESCRIPTION:hel\r\n lo\r\n\twor\r\n ld\nB:2\n")).toEqual(["A:1", "DESCRIPTION:helloworld", "B:2"]);
  });

  it("parses names, parameters (quoted, with : and ;) and values", () => {
    expect(parseContentLine('DTSTART;TZID="America/New_York";X-A=b:20261201T150000')).toEqual({
      name: "DTSTART",
      params: { TZID: "America/New_York", "X-A": "b" },
      value: "20261201T150000",
    });
    expect(parseContentLine('X-X;P="a:b;c":v:w')).toEqual({ name: "X-X", params: { P: "a:b;c" }, value: "v:w" });
    expect(parseContentLine("uid:abc")?.name).toBe("UID");
    expect(parseContentLine("no colon here")).toBeNull();
  });
});

describe("parseIcs", () => {
  it("reads Airbnb-style all-day events", () => {
    const { events } = parseIcs(AIRBNB);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      uid: "1418fb94e984-a1b2c3d4e5f6@airbnb.com",
      start: { kind: "date", date: "2026-12-05" },
      end: { kind: "date", date: "2026-12-10" },
      status: null,
      recurring: false,
    });
  });

  it("reads Vrbo-style feeds with LF line ends", () => {
    const { events } = parseIcs(VRBO);
    expect(events).toHaveLength(1);
    expect(events[0].start).toEqual({ kind: "date", date: "2026-12-15" });
  });

  it("reads UTC, TZID and floating date-times, DURATION, STATUS, SEQUENCE and recurrence", () => {
    const { events } = parseIcs(
      ics(
        ...vevent("UID:a", "DTSTART:20261201T150000Z", "DTEND:20261203T110000Z", "STATUS:cancelled", "SEQUENCE:3"),
        ...vevent("UID:b", "DTSTART;TZID=Europe/Paris:20261201T150000", "DURATION:P2DT1H"),
        ...vevent("UID:c", "DTSTART:20261201T150000", "RRULE:FREQ=WEEKLY;COUNT=3"),
        ...vevent("UID:c", "RECURRENCE-ID:20261208T150000", "DTSTART:20261209T150000"),
        "BEGIN:VTODO",
        "UID:not-an-event",
        "END:VTODO",
      ),
    );
    expect(events.map((e) => e.uid)).toEqual(["a", "b", "c", "c"]);
    expect(events[0]).toMatchObject({ start: { kind: "utc", instant: Date.UTC(2026, 11, 1, 15) }, status: "CANCELLED", sequence: 3 });
    expect(events[1]).toMatchObject({ start: { kind: "local", dateTime: "2026-12-01T15:00:00", tzid: "Europe/Paris" }, duration: "P2DT1H" });
    expect(events[2]).toMatchObject({ start: { kind: "local", tzid: null }, recurring: true });
    expect(events[3].recurring).toBe(true);
  });

  it("ignores events nested in other components and unknown properties", () => {
    const { events } = parseIcs(ics("BEGIN:VTIMEZONE", "TZID:X", "BEGIN:STANDARD", "DTSTART:19701025T030000", "END:STANDARD", "END:VTIMEZONE", ...vevent("UID:z", "DTSTART;VALUE=DATE:20261201", "X-FOO:bar")));
    expect(events).toHaveLength(1);
  });

  it("marks malformed dates as invalid instead of throwing", () => {
    const { events } = parseIcs(ics(...vevent("UID:bad", "DTSTART;VALUE=DATE:2026-13-45")));
    expect(events[0].start).toBeNull();
  });

  it("rejects text that is not a calendar", () => {
    expect(() => parseIcs("<html>Not found</html>")).toThrow(IcalParseError);
    expect(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n")).toThrow(/END:VCALENDAR/);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts wall times in a zone, across DST", () => {
    expect(zonedTimeToUtc("2026-07-01T12:00:00", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 16));
    expect(zonedTimeToUtc("2026-12-01T12:00:00", "America/New_York")).toBe(Date.UTC(2026, 11, 1, 17));
    expect(zonedTimeToUtc("2026-12-01T00:30:00", "Asia/Tokyo")).toBe(Date.UTC(2026, 10, 30, 15, 30));
  });
});

describe("normalizeEvents", () => {
  const opts = { timeZone: "America/New_York", today: "2026-11-22" };
  const norm = (text: string, o = opts) => normalizeEvents(parseIcs(text).events, o);

  it("turns all-day events into [check_in, check_out) nights", () => {
    expect(norm(AIRBNB).blocks).toEqual([
      { uid: "1418fb94e984-a1b2c3d4e5f6@airbnb.com", check_in: "2026-12-05", check_out: "2026-12-10" },
      { uid: "7f3e1b2a-0000@airbnb.com", check_in: "2026-12-28", check_out: "2027-01-05" },
    ]);
  });

  it("uses the listing-local date of date-time events and blocks at least one night", () => {
    const { blocks } = norm(
      ics(
        // 15:00 → 11:00 two days later in New York = nights 1 and 2.
        ...vevent("UID:utc", "DTSTART:20261201T200000Z", "DTEND:20261203T160000Z"),
        // 01:00 UTC on the 5th is still the 4th in New York.
        ...vevent("UID:late", "DTSTART:20261205T010000Z", "DTEND:20261206T010000Z"),
        // A same-day event blocks that night.
        ...vevent("UID:short", "DTSTART;TZID=America/New_York:20261210T100000", "DTEND;TZID=America/New_York:20261210T120000"),
        // Floating time = listing timezone; DURATION instead of DTEND.
        ...vevent("UID:dur", "DTSTART:20261212T160000", "DURATION:P3D"),
        // No DTEND: an all-day event lasts one day.
        ...vevent("UID:oneday", "DTSTART;VALUE=DATE:20261220"),
        // Unknown TZID falls back to the listing timezone.
        ...vevent("UID:win", "DTSTART;TZID=Pacific Standard Time:20261222T150000", "DTEND;TZID=Pacific Standard Time:20261224T110000"),
      ),
    );
    expect(blocks).toEqual([
      { uid: "utc", check_in: "2026-12-01", check_out: "2026-12-03" },
      { uid: "late", check_in: "2026-12-04", check_out: "2026-12-05" },
      { uid: "short", check_in: "2026-12-10", check_out: "2026-12-11" },
      { uid: "dur", check_in: "2026-12-12", check_out: "2026-12-15" },
      { uid: "oneday", check_in: "2026-12-20", check_out: "2026-12-21" },
      { uid: "win", check_in: "2026-12-22", check_out: "2026-12-24" },
    ]);
  });

  it("skips cancelled, recurring, past and invalid events and counts them", () => {
    const result = norm(
      ics(
        ...vevent("UID:x", "STATUS:CANCELLED", "DTSTART;VALUE=DATE:20261201", "DTEND;VALUE=DATE:20261203"),
        ...vevent("UID:r", "DTSTART;VALUE=DATE:20261201", "RRULE:FREQ=DAILY"),
        ...vevent("UID:past", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261122"),
        ...vevent("UID:now", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261123"),
        ...vevent("UID:bad", "DTSTART;VALUE=DATE:20261205", "DTEND;VALUE=DATE:20261201"),
        ...vevent("UID:nostart", "SUMMARY:x"),
      ),
    );
    expect(result.blocks).toEqual([{ uid: "now", check_in: "2026-11-20", check_out: "2026-11-23" }]);
    expect(result.skipped).toEqual({ cancelled: 1, recurring: 1, past: 1, invalid: 2, duplicate: 0 });
  });

  it("keeps the highest SEQUENCE for duplicate UIDs and derives UIDs when missing", () => {
    const { blocks, skipped } = norm(
      ics(
        ...vevent("UID:d", "SEQUENCE:2", "DTSTART;VALUE=DATE:20261205", "DTEND;VALUE=DATE:20261207"),
        ...vevent("UID:d", "SEQUENCE:1", "DTSTART;VALUE=DATE:20261201", "DTEND;VALUE=DATE:20261203"),
        ...vevent("DTSTART;VALUE=DATE:20261210", "DTEND;VALUE=DATE:20261212"),
      ),
    );
    expect(blocks).toEqual([
      { uid: "d", check_in: "2026-12-05", check_out: "2026-12-07" },
      { uid: "nouid:2026-12-10:2026-12-12", check_in: "2026-12-10", check_out: "2026-12-12" },
    ]);
    expect(skipped.duplicate).toBe(1);
  });

  it("cuts very long blocks and limits UID length", () => {
    const long = "u".repeat(2000);
    const { blocks } = norm(ics(...vevent(`UID:${long}`, "DTSTART;VALUE=DATE:20261201", "DTEND;VALUE=DATE:20351201")));
    expect(blocks[0].check_out).toBe("2029-12-05"); // 1,100 nights
    expect(blocks[0].uid.length).toBeLessThanOrEqual(500);
  });

  it("refuses feeds with too many events", () => {
    const many = Array.from({ length: 6 }, (_, i) => vevent(`UID:${i}`, `DTSTART;VALUE=DATE:202612${String(i + 10)}`)).flat();
    expect(() => norm(ics(...many), { ...opts, maxEvents: 5 } as typeof opts)).toThrow(/more than 5 events/);
  });
});

describe("export generator", () => {
  it("merges consecutive busy nights into ranges", () => {
    expect(mergeBusyNights(["2026-12-01", "2026-12-02", "2026-12-04", "2026-12-03", "2026-12-10"])).toEqual([
      { from: "2026-12-01", to: "2026-12-05" },
      { from: "2026-12-10", to: "2026-12-11" },
    ]);
    expect(mergeBusyNights([])).toEqual([]);
  });

  it("folds long lines at 75 octets without splitting UTF-8 characters", () => {
    const line = "SUMMARY:" + "é".repeat(60);
    const folded = foldLine(line);
    for (const part of folded.split(CRLF)) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    expect(unfoldLines(folded + CRLF)).toEqual([line]);
    expect(foldLine("SHORT:1")).toBe("SHORT:1");
  });

  it("builds a valid RFC 5545 calendar with CRLF, DTSTAMP, PRODID and all-day events", () => {
    const now = new Date(Date.UTC(2026, 10, 22, 9, 30, 5));
    const body = buildIcs({ listingKey: "listing-1", ranges: [{ from: "2026-12-01", to: "2026-12-04" }], now });
    expect(body.endsWith(CRLF)).toBe(true);
    expect(body.replace(/\r\n/g, "")).not.toMatch(/\n/);
    const lines = body.split(CRLF);
    expect(lines.slice(0, 2)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0"]);
    expect(lines).toContain("PRODID:-//PMS//iCal export 1.0//EN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("DTSTAMP:20261122T093005Z");
    expect(lines).toContain("DTSTART;VALUE=DATE:20261201");
    expect(lines).toContain("DTEND;VALUE=DATE:20261204");
    expect(lines).toContain("SUMMARY:Not available");
    expect(lines).toContain(`UID:${exportUid("listing-1", "2026-12-01")}`);

    // Round trip through our own parser.
    const parsed = normalizeEvents(parseIcs(body).events, { timeZone: "America/New_York", today: "2026-11-22" });
    expect(parsed.blocks).toEqual([{ uid: exportUid("listing-1", "2026-12-01"), check_in: "2026-12-01", check_out: "2026-12-04" }]);
  });

  it("uses stable UIDs that do not reveal the listing id", () => {
    expect(exportUid("abc", "2026-12-01")).toBe(exportUid("abc", "2026-12-01"));
    expect(exportUid("abc", "2026-12-01")).not.toBe(exportUid("abd", "2026-12-01"));
    expect(exportUid("abc", "2026-12-01")).not.toContain("abc");
    expect(exportUid("abc", "2026-12-01")).toMatch(/^20261201-[0-9a-f]{16}@/);
  });

  it("produces an empty but valid calendar when nothing is busy", () => {
    const body = buildIcs({ listingKey: "x", ranges: [], now: new Date() });
    expect(body).not.toContain("BEGIN:VEVENT");
    expect(parseIcs(body).events).toEqual([]);
  });
});

describe("fetchFeed", () => {
  const publicLookup = async () => [{ address: "93.184.216.34" }];
  const okResponse = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

  it("returns the body, ETag and Last-Modified, and sends conditional headers", async () => {
    let sent: Headers | undefined;
    const result = await fetchFeed("https://feeds.example.com/a.ics", {
      etag: '"v1"',
      lastModified: "Sat, 21 Nov 2026 10:00:00 GMT",
      lookup: publicLookup,
      fetchImpl: async (_url, init) => {
        sent = new Headers(init?.headers);
        return okResponse(AIRBNB, { etag: '"v2"', "last-modified": "Sun, 22 Nov 2026 10:00:00 GMT" });
      },
    });
    expect(sent?.get("if-none-match")).toBe('"v1"');
    expect(sent?.get("if-modified-since")).toBe("Sat, 21 Nov 2026 10:00:00 GMT");
    expect(result).toEqual({ status: "ok", body: AIRBNB, etag: '"v2"', lastModified: "Sun, 22 Nov 2026 10:00:00 GMT" });
  });

  it("reports 304 as not modified", async () => {
    const result = await fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, fetchImpl: async () => new Response(null, { status: 304 }) });
    expect(result).toEqual({ status: "not_modified" });
  });

  it("blocks private destinations, also after DNS resolution and on redirects", async () => {
    const never = async () => {
      throw new Error("must not fetch");
    };
    await expect(fetchFeed("https://169.254.169.254/latest", { fetchImpl: never })).rejects.toThrow(/private/);
    await expect(fetchFeed("http://feeds.example.com/a.ics", { fetchImpl: never, lookup: publicLookup })).rejects.toThrow(/https/);
    await expect(fetchFeed("https://sneaky.example.com/a.ics", { fetchImpl: never, lookup: async () => [{ address: "10.0.0.1" }] })).rejects.toThrow(
      /private address/,
    );
    const redirecting = async (url: string | URL | Request) =>
      String(url).includes("start") ? new Response(null, { status: 302, headers: { location: "https://internal.example.com/x" } }) : okResponse(AIRBNB);
    await expect(
      fetchFeed("https://feeds.example.com/start", {
        fetchImpl: redirecting,
        lookup: async (host) => (host === "internal.example.com" ? [{ address: "192.168.1.10" }] : [{ address: "93.184.216.34" }]),
      }),
    ).rejects.toThrow(/private address/);
  });

  it("follows a few public redirects, then gives up", async () => {
    let calls = 0;
    const result = await fetchFeed("https://feeds.example.com/start", {
      lookup: publicLookup,
      fetchImpl: async (url) => {
        calls++;
        return String(url).endsWith("/final") ? okResponse(VRBO) : new Response(null, { status: 301, headers: { location: "/final" } });
      },
    });
    expect(result.status).toBe("ok");
    expect(calls).toBe(2);
    await expect(
      fetchFeed("https://feeds.example.com/loop", {
        lookup: publicLookup,
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
      }),
    ).rejects.toThrow(/too many redirects/);
  });

  it("enforces the size limit while streaming", async () => {
    const big = "X".repeat(2048);
    await expect(fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, maxBytes: 1000, fetchImpl: async () => okResponse(big) })).rejects.toThrow(
      /larger than/,
    );
    await expect(
      fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, maxBytes: 1000, fetchImpl: async () => okResponse("x", { "content-length": "5000" }) }),
    ).rejects.toThrow(/larger than/);
  });

  it("times out and reports HTTP errors", async () => {
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, timeoutMs: 20, fetchImpl: hang })).rejects.toThrow(/timed out/);
    await expect(
      fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, fetchImpl: async () => new Response("nope", { status: 404 }) }),
    ).rejects.toThrow(FeedFetchError);
    await expect(
      fetchFeed("https://feeds.example.com/a.ics", { lookup: publicLookup, fetchImpl: async () => new Response("nope", { status: 404 }) }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("export tokens and feed URLs", () => {
  it("makes 256-bit tokens that the route recognises", () => {
    const token = newExportToken();
    expect(isExportToken(token)).toBe(true);
    expect(token).not.toBe(newExportToken());
    expect(tokenFromSegment(`${token}.ics`)).toBe(token);
    expect(tokenFromSegment(token)).toBe(token);
    expect(tokenFromSegment("nope.ics")).toBeNull();
    expect(tokenFromSegment("pmsical_../../etc.ics")).toBeNull();
    expect(exportUrl("https://app.example.com/", token)).toBe(`https://app.example.com/ical/${token}.ics`);
  });

  it("shows feed URLs without their secret parts", () => {
    expect(feedUrlDisplay(new URL("https://www.airbnb.com/calendar/ical/123.ics?s=abcdef"))).toBe("www.airbnb.com/calendar/…");
    expect(feedUrlDisplay(new URL("https://www.vrbo.com/icalendar/0123456789abcdef.ics"))).toBe("www.vrbo.com/icalendar/…");
    expect(feedUrlDisplay(new URL("https://example.com/"))).toBe("example.com");
    expect(feedUrlHash(new URL("https://Example.com/a.ics"))).toBe(feedUrlHash(new URL("https://example.com/a.ics")));
  });
});

describe("syncFeed", () => {
  const key = randomBytes(32);
  const url = "https://feeds.example.com/a.ics";
  const feed = { feedId: "feed-1", urlCiphertext: encryptSecret(url, key, "feed-1"), etag: '"old"', lastModified: null, timeZone: "America/New_York" };
  const lookup = async () => [{ address: "93.184.216.34" }];

  function stubClient(answers: Record<string, { data?: unknown; error?: { message: string } | null }> = {}) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: answers[fn]?.data ?? null, error: answers[fn]?.error ?? null });
      },
    };
  }

  it("fetches, normalises and hands the blocks to the database", async () => {
    const client = stubClient({ apply_ical_feed_sync: { data: { status: "ok", events: 2 } } });
    const outcome = await syncFeed(client as never, feed, {
      encryptionKey: key,
      now: new Date(Date.UTC(2026, 10, 22, 12)),
      fetch: { lookup, fetchImpl: async () => new Response(AIRBNB, { headers: { etag: '"new"' } }) },
    });
    expect(outcome).toEqual({ ok: true, result: { status: "ok", events: 2 } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].fn).toBe("apply_ical_feed_sync");
    expect(client.calls[0].args).toMatchObject({
      p_feed_id: "feed-1",
      p_events: [
        { uid: "1418fb94e984-a1b2c3d4e5f6@airbnb.com", check_in: "2026-12-05", check_out: "2026-12-10" },
        { uid: "7f3e1b2a-0000@airbnb.com", check_in: "2026-12-28", check_out: "2027-01-05" },
      ],
      p_meta: { etag: '"new"', skipped: { cancelled: 0 } },
    });
  });

  it("passes null events on 304 so the database keeps everything", async () => {
    const client = stubClient({ apply_ical_feed_sync: { data: { status: "ok", unchanged: true } } });
    await syncFeed(client as never, feed, { encryptionKey: key, fetch: { lookup, fetchImpl: async () => new Response(null, { status: 304 }) } });
    expect(client.calls[0].args.p_events).toBeNull();
  });

  it("records fetch, parse and decryption failures on the feed", async () => {
    for (const [fetchImpl, message] of [
      [async () => new Response("<html>", { status: 200 }), /Not an iCal feed/],
      [async () => new Response("", { status: 403 }), /HTTP 403/],
    ] as const) {
      const client = stubClient();
      const outcome = await syncFeed(client as never, feed, { encryptionKey: key, fetch: { lookup, fetchImpl } });
      expect(outcome.ok).toBe(false);
      expect(client.calls.map((c) => c.fn)).toEqual(["record_ical_feed_failure"]);
      expect(String(client.calls[0].args.p_error)).toMatch(message);
    }
    const client = stubClient();
    await syncFeed(client as never, feed, { encryptionKey: randomBytes(32) });
    expect(String(client.calls[0].args.p_error)).toMatch(/decrypt/);
  });

  it("records database refusals in plain words", async () => {
    const client = stubClient({ apply_ical_feed_sync: { error: { message: "listing_not_bookable: x is archived" } } });
    const outcome = await syncFeed(client as never, feed, { encryptionKey: key, fetch: { lookup, fetchImpl: async () => new Response(VRBO) } });
    expect(outcome).toEqual({ ok: false, error: "The listing is archived or cannot take blocks." });
    expect(client.calls.map((c) => c.fn)).toEqual(["apply_ical_feed_sync", "record_ical_feed_failure"]);
  });
});
