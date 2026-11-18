// Calendar invites (.ics) for booked visits.

/** UTC instant for a wall-clock time in London on a date. */
export function londonToUtc(date: string, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const guess = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`);
  // London is UTC+0 or UTC+1; find which by formatting the guess in London.
  const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(guess));
  const offset = (londonHour - guess.getUTCHours() + 24) % 24;
  return new Date(guess.getTime() - offset * 3600 * 1000);
}

/** "9:30", "09.30", "9am", "2pm" -> "09:30"; anything else -> null. */
export function parseTime(t: string | null | undefined): string | null {
  if (!t) return null;
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (d: string) => d.replace(/-/g, "");

function addDay(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Escapes text for an .ics property and folds long lines. */
function prop(name: string, value: string): string {
  const v = value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const line = `${name}:${v}`;
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export type Invite = {
  uid: string;
  sequence: number;
  method: "REQUEST" | "CANCEL";
  dates: string[];
  time: string | null;
  summary: string;
  location: string;
  description: string;
  organizer: { name: string; email: string };
  attendees: { name: string; email: string }[];
};

/**
 * One event per run of consecutive dates. With an arrival time each day runs
 * from then until 5pm; without one the days are all-day events.
 */
export function buildIcs(inv: Invite): string {
  const runs: string[][] = [];
  for (const d of inv.dates) {
    const last = runs[runs.length - 1];
    if (last && addDay(last[last.length - 1]) === d && !inv.time) last.push(d);
    else runs.push([d]);
  }
  const now = stamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ALPS Consultancy//ALPS CRM//EN", "CALSCALE:GREGORIAN", `METHOD:${inv.method}`];
  runs.forEach((run, i) => {
    lines.push("BEGIN:VEVENT");
    lines.push(prop("UID", runs.length === 1 ? inv.uid : `${inv.uid}-${i + 1}`));
    lines.push(`SEQUENCE:${inv.sequence}`);
    lines.push(`DTSTAMP:${now}`);
    if (inv.time) {
      const start = londonToUtc(run[0], inv.time);
      let end = londonToUtc(run[0], "17:00");
      if (end <= start) end = new Date(start.getTime() + 2 * 3600 * 1000);
      lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(run[0])}`, `DTEND;VALUE=DATE:${dateOnly(addDay(run[run.length - 1]))}`);
    }
    lines.push(prop("SUMMARY", inv.summary));
    if (inv.location) lines.push(prop("LOCATION", inv.location));
    lines.push(prop("DESCRIPTION", inv.description));
    lines.push(prop(`ORGANIZER;CN=${inv.organizer.name.replace(/[;:,"]/g, " ")}`, `mailto:${inv.organizer.email}`));
    for (const a of inv.attendees) {
      lines.push(prop(`ATTENDEE;CN=${a.name.replace(/[;:,"]/g, " ")};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE`, `mailto:${a.email}`));
    }
    lines.push(`STATUS:${inv.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
