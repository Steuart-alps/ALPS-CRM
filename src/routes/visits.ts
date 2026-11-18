import { Router } from "express";
import { one, query } from "../db.ts";
import { html, ukDate, todayUk, MONTHS, opt, checked, type SafeHtml } from "../html.ts";
import { s, int, dateOrNull, idParam, page, NotFound } from "../util.ts";
import { setFlash } from "../auth.ts";
import { assessors, VISIT_STATUS_LABEL } from "../lookups.ts";
import { miles, orderStops, splitTrips, postcodeArea, type Point } from "../geo.ts";
import { WEEKDAYS, weekdaysText, VISIT_TYPES } from "./clients.ts";
import { sendVisitInvites } from "../invites.ts";

/** ISO weekday 1 (Mon) to 7 (Sun) of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const d = new Date(date + "T12:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The days a visit covers: `days` consecutive working days from the start.
 * Weekends are skipped unless the client accepts weekend visits.
 */
export function visitDates(start: string, days: number, allowed: number[] = []): string[] {
  const out: string[] = [];
  let d = start;
  const weekendOk = (wd: number) => allowed.includes(wd);
  for (let guard = 0; out.length < days && guard < 30; guard++) {
    const wd = isoWeekday(d);
    if (out.length === 0 || wd <= 5 || weekendOk(wd)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export function dateRangeText(dates: string[]): string {
  if (dates.length === 0) return "";
  const fmt = (x: string) => `${WEEKDAYS[isoWeekday(x) - 1]} ${ukDate(x)}`;
  return dates.length === 1 ? fmt(dates[0]) : `${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}`;
}

type VisitRow = {
  id: number; client_id: number; year: number; month: number; seq: number; days: number;
  assessor_id: number | null; status: string; booked_on: string | null; booked_time: string | null;
  done_on: string | null; notes: string | null; visit_type: string | null;
  invited_at: string | null; invite_client_email: string | null; invite_assessor_email: string | null;
  client_response: string | null; client_response_note: string | null;
  assessor_response: string | null; assessor_response_note: string | null;
  client_name: string; postcode: string | null; town: string | null; lat: number | null; lng: number | null;
  visit_weekdays: number[]; phone: string | null; assessor_name: string | null;
};

const VISIT_SELECT = `
  select v.*, c.name as client_name, c.postcode, c.town, c.lat, c.lng, c.visit_weekdays, c.phone,
         a.name as assessor_name
    from visits v
    join clients c on c.id = v.client_id
    left join assessors a on a.id = v.assessor_id`;

/** Problems with booking a visit on these dates, for the person to confirm. */
export async function bookingWarnings(v: VisitRow, assessorId: number | null, start: string): Promise<string[]> {
  const warnings: string[] = [];
  const dates = visitDates(start, v.days, v.visit_weekdays);
  const allowed = v.visit_weekdays;
  if (allowed.length) {
    const bad = dates.filter((d) => !allowed.includes(isoWeekday(d)));
    if (bad.length) warnings.push(`${v.client_name} only accepts visits on ${weekdaysText(allowed).replace(" only", "")}. ${dateRangeText(bad)} isn't one of those.`);
  }
  const startMonth = Number(start.slice(5, 7));
  const startYear = Number(start.slice(0, 4));
  if (startMonth !== v.month || startYear !== v.year) {
    warnings.push(`This visit is due in ${MONTHS[v.month - 1]} ${v.year}, but the date is in ${MONTHS[startMonth - 1]} ${startYear}.`);
  }
  if (assessorId) {
    const others = await query<{ id: number; client_name: string; booked_on: string; days: number; visit_weekdays: number[] }>(
      `select v.id, c.name as client_name, v.booked_on, v.days, c.visit_weekdays from visits v join clients c on c.id = v.client_id
        where v.assessor_id = $1 and v.status = 'booked' and v.id <> $2
          and v.booked_on between $3::date - 14 and $3::date + 14`,
      [assessorId, v.id, start],
    );
    for (const o of others) {
      const theirs = new Set(visitDates(o.booked_on, o.days, o.visit_weekdays));
      const clash = dates.filter((d) => theirs.has(d));
      if (clash.length) warnings.push(`The assessor is already booked at ${o.client_name} on ${dateRangeText(clash)}.`);
    }
    const away = await query<{ from_date: string; to_date: string; note: string | null }>(
      "select from_date, to_date, note from assessor_away where assessor_id = $1 and to_date >= $2 and from_date <= $3",
      [assessorId, dates[0], dates[dates.length - 1]],
    );
    for (const a of away) {
      const hit = dates.filter((d) => d >= a.from_date && d <= a.to_date);
      if (hit.length) warnings.push(`The assessor is away on ${dateRangeText(hit)}${a.note ? ` (${a.note})` : ""}.`);
    }
  }
  return warnings;
}

function visitLine(v: VisitRow, extra?: SafeHtml): SafeHtml {
  const dates = v.booked_on ? visitDates(v.booked_on, v.days, v.visit_weekdays) : [];
  return html`<li>
    <a href="/visits/${v.id}"><strong>${v.client_name}</strong></a>
    ${v.visit_type ? html` <span class="chip">${VISIT_TYPES[v.visit_type]}</span>` : ""}
    <span class="small muted">${v.town || v.postcode ? ` · ${[v.town, v.postcode].filter(Boolean).join(" ")}` : " · no address"} · ${v.days} day${v.days > 1 ? "s" : ""}${v.visit_weekdays.length ? html` · ${weekdaysText(v.visit_weekdays)}` : ""}</span>
    ${v.status === "booked" ? html`<br><span class="chip good">Booked</span> ${dateRangeText(dates)}${v.booked_time ? ` · ${v.booked_time}` : ""}
      ${v.client_response === "change" || v.assessor_response === "change" ? html` <span class="chip bad">Asked for another date</span>`
        : v.invited_at && (v.client_response !== "accepted" || v.assessor_response !== "accepted") ? html` <span class="chip warn">Waiting for acceptance</span>`
        : v.invited_at ? html` <span class="chip good">Accepted</span>` : ""}`
      : v.status === "done" ? html`<br><span class="chip">Done</span> ${v.done_on ? ukDate(v.done_on) : ""}`
      : html`<br><span class="chip warn">To book</span>`}
    ${extra ?? ""}
  </li>`;
}

export function visitsRouter(): Router {
  const r = Router();

  r.get("/visits", async (req, res) => {
    const today = todayUk();
    const year = int(req.query.year) ?? Number(today.slice(0, 4));
    const month = int(req.query.month) ?? Number(today.slice(5, 7));
    const gap = int(req.query.gap) ?? 30;
    const as = await assessors();
    const [rows, missed] = await Promise.all([
      query<VisitRow>(`${VISIT_SELECT} where v.year = $1 and v.month = $2 and v.status <> 'cancelled'`, [year, month]),
      query<VisitRow>(`${VISIT_SELECT} where v.status = 'to_book' and v.year * 12 + v.month < $1 order by v.year, v.month`, [
        Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)),
      ]),
    ]);
    const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
    const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

    const people = [...as.filter((a) => rows.some((v) => v.assessor_id === a.id) || a.active), { id: null, name: "No assessor set", home_lat: null, home_lng: null, home_postcode: null }];
    const sections = people.map((a) => {
      const mine = rows.filter((v) => v.assessor_id === a.id);
      if (mine.length === 0 && a.id === null) return html``;
      const home: Point | null = a.home_lat !== null && a.home_lng !== null ? { lat: a.home_lat, lng: a.home_lng } : null;
      const open = mine.filter((v) => v.status !== "done");
      const done = mine.filter((v) => v.status === "done");
      const stops = open.map((v) => ({ v, point: v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : null }));
      const trips = splitTrips(orderStops(home, stops), gap);
      const toBook = open.filter((v) => v.status === "to_book").length;
      const dayCount = open.reduce((t, v) => t + v.days, 0);
      return html`<section class="card">
  <div class="spread"><h2>${a.name}</h2>
    <span class="small muted">${open.length} visit${open.length === 1 ? "" : "s"} · ${dayCount} day${dayCount === 1 ? "" : "s"} · ${toBook} to book${a.id && !home ? " · add a home postcode in Settings for routes" : ""}</span></div>
  ${trips.map((trip, i) => {
    const pts = trip.map((t) => t.point).filter((p): p is Point => !!p);
    let span = 0;
    for (let k = 1; k < pts.length; k++) span += miles(pts[k - 1], pts[k]);
    const areas = [...new Set(trip.map((t) => postcodeArea(t.v.postcode)))].join(", ");
    const fromHome = home && pts[0] ? Math.round(miles(home, pts[0])) : null;
    return html`<h3 class="small" style="margin:.75rem 0 .25rem">Trip ${i + 1}: ${areas} area · ${trip.length} client${trip.length === 1 ? "" : "s"}${pts.length > 1 ? ` · about ${Math.round(span)} miles between them` : ""}${fromHome !== null ? ` · ${fromHome} miles from home` : ""}${pts.length === 0 ? " · no postcode location yet" : ""}</h3>
    <ol class="list">${trip.map((t) => visitLine(t.v))}</ol>`;
  })}
  ${open.length === 0 ? html`<p class="muted">Nothing due this month.</p>` : ""}
  ${done.length ? html`<details><summary class="small">Done (${done.length})</summary><ul class="list">${done.map((v) => visitLine(v))}</ul></details>` : ""}
</section>`;
    });

    page(req, res, "Visit planner", html`
<div class="spread"><h1>Visits for ${MONTHS[month - 1]} ${year}</h1>
  <div class="row">
    <a class="button secondary" href="/visits?year=${prev.y}&month=${prev.m}">&larr; ${MONTHS[prev.m - 1]}</a>
    <a class="button secondary" href="/visits?year=${next.y}&month=${next.m}">${MONTHS[next.m - 1]} &rarr;</a>
  </div>
</div>
<p class="small muted">Each assessor's visits are put in a driving order from their home postcode and split into trips wherever the next client is more than ${gap} miles away, so a whole area can be booked together.
  <a href="/visits?year=${year}&month=${month}&gap=${gap === 30 ? 60 : 30}">Use ${gap === 30 ? 60 : 30} miles instead</a>.</p>
${missed.length ? html`<section class="card">
  <h2 class="overdue">Not booked and their month has passed (${missed.length})</h2>
  <ul class="list">${missed.map((v) => visitLine(v, html`<span class="small muted"> · was due ${MONTHS[v.month - 1]} ${v.year} · ${v.assessor_name ?? "no assessor"}</span>`))}</ul>
</section>` : ""}
${sections}`, "visits");
  });

  r.get("/visits/:id", async (req, res) => {
    const v = await one<VisitRow>(`${VISIT_SELECT} where v.id = $1`, [idParam(req)]);
    if (!v) throw new NotFound();
    page(req, res, `Visit: ${v.client_name}`, await visitPage(v, []), "visits");
  });

  r.post("/visits/:id", async (req, res) => {
    const v = await one<VisitRow>(`${VISIT_SELECT} where v.id = $1`, [idParam(req)]);
    if (!v) throw new NotFound();
    const assessorId = int(req.body.assessor_id);
    const action = String(req.body.action ?? "save");
    const bookedOn = dateOrNull(req.body.booked_on);
    const time = s(req.body.booked_time);
    const notes = s(req.body.notes);
    const sendInvites = req.body.send_invites === "1";
    let status = v.status;
    let doneOn = v.done_on;

    if (action === "accept_by_hand") {
      const who = req.body.who === "assessor" ? "assessor" : "client";
      await query(`update visits set ${who}_response = 'accepted', ${who}_response_at = now(), ${who}_response_note = 'Ticked by ' || $2 where id = $1`, [v.id, req.user!.name]);
      setFlash(req, "Marked as accepted.");
      return res.redirect(`/visits/${v.id}`);
    }
    if (action === "resend") {
      const r2 = await sendVisitInvites(v.id, "book");
      setFlash(req, inviteMessage(r2));
      return res.redirect(`/visits/${v.id}`);
    }

    if (action === "book") {
      if (!bookedOn) {
        setFlash(req, "Pick the first day of the visit to book it.");
        return res.redirect(`/visits/${v.id}`);
      }
      if (req.body.confirm !== "1") {
        const warnings = await bookingWarnings(v, assessorId, bookedOn);
        if (warnings.length) {
          return page(req, res, `Visit: ${v.client_name}`, await visitPage({ ...v, assessor_id: assessorId, booked_on: bookedOn, booked_time: time, notes }, warnings, sendInvites), "visits");
        }
      }
      status = "booked";
    } else if (action === "done") {
      status = "done";
      doneOn = dateOrNull(req.body.done_on) ?? v.booked_on ?? todayUk();
    } else if (action === "unbook") {
      status = "to_book";
    } else if (action === "cancel") {
      status = "cancelled";
    } else if (action === "reopen") {
      status = v.booked_on ? "booked" : "to_book";
      doneOn = null;
    }

    const newBooked = status === "to_book" ? null : action === "book" ? bookedOn : v.booked_on;
    const newTime = status === "to_book" ? null : action === "book" ? time : v.booked_time;
    const wasInvited = !!v.invited_at;
    // Tell people before the booking details change, so a cancellation names the old dates.
    let inviteNote = "";
    if (wasInvited && (status === "to_book" || status === "cancelled")) {
      inviteNote = " " + inviteMessage(await sendVisitInvites(v.id, "cancel"), true);
    }
    await query(
      `update visits set assessor_id = $2, status = $3, booked_on = $4, booked_time = $5, notes = $6, done_on = $7, updated_at = now() where id = $1`,
      [v.id, assessorId, status, newBooked, newTime, notes, status === "done" ? doneOn : null],
    );
    if (action === "book") {
      const changed = v.status !== "booked" || v.booked_on !== bookedOn || (v.booked_time ?? null) !== time || v.assessor_id !== assessorId;
      if (sendInvites && (changed || !wasInvited)) inviteNote = " " + inviteMessage(await sendVisitInvites(v.id, "book"));
      else if (wasInvited && changed) inviteNote = " The dates changed but no new invites were sent: use Send invites again if people need to know.";
    }
    if (status !== v.status || (action === "book" && v.booked_on !== bookedOn)) {
      const label = status === "booked" && bookedOn ? `Visit ${v.seq} (${MONTHS[v.month - 1]} ${v.year}) booked for ${dateRangeText(visitDates(bookedOn, v.days, v.visit_weekdays))}.`
        : `Visit ${v.seq} (${MONTHS[v.month - 1]} ${v.year}) marked ${VISIT_STATUS_LABEL[status].toLowerCase()}.`;
      await query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'visit', $3)", [v.client_id, req.user!.id, label]);
    }
    setFlash(req, "Visit saved." + inviteNote);
    res.redirect(`/visits/${v.id}`);
  });

  return r;
}

function inviteMessage(r: { sent: string[]; missing: string[] }, cancel = false): string {
  const parts: string[] = [];
  if (r.sent.length) parts.push(`${cancel ? "Cancellation" : "Invite"} sent to ${r.sent.join(" and ")}.`);
  if (r.missing.length) parts.push(`Not sent: ${r.missing.join("; ")}.`);
  return parts.join(" ") || (cancel ? "" : "No invites sent.");
}

type Suggestion = { start: string; dates: string[]; near: string | null; nearMiles: number | null };

/**
 * Start dates in the visit's month (from tomorrow) when the assessor is free
 * and the client accepts visits. Days next to the assessor's other bookings
 * nearby come first, so trips join up.
 */
export async function suggestDates(v: VisitRow, assessorId: number | null): Promise<Suggestion[]> {
  if (!assessorId) return [];
  const today = todayUk();
  const first = `${v.year}-${String(v.month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(v.year, v.month, 0)).toISOString().slice(0, 10);
  const [booked, away] = await Promise.all([
    query<{ booked_on: string; days: number; visit_weekdays: number[]; lat: number | null; lng: number | null; client_name: string }>(
      `select v.booked_on, v.days, c.visit_weekdays, c.lat, c.lng, c.name as client_name from visits v join clients c on c.id = v.client_id
        where v.assessor_id = $1 and v.status = 'booked' and v.id <> $2 and v.booked_on between $3::date - 10 and $4::date + 10`,
      [assessorId, v.id, first, last],
    ),
    query<{ from_date: string; to_date: string }>(
      "select from_date, to_date from assessor_away where assessor_id = $1 and to_date >= $2 and from_date <= $3",
      [assessorId, first, last],
    ),
  ]);
  const busy = new Map<string, { lat: number | null; lng: number | null; client_name: string }>();
  for (const b of booked) for (const d of visitDates(b.booked_on, b.days, b.visit_weekdays)) busy.set(d, b);
  const isAway = (d: string) => away.some((a) => d >= a.from_date && d <= a.to_date);
  const here = v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : null;
  const out: Suggestion[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (d <= today) continue;
    const wd = isoWeekday(d);
    if (v.visit_weekdays.length ? !v.visit_weekdays.includes(wd) : wd > 5) continue;
    const dates = visitDates(d, v.days, v.visit_weekdays);
    if (dates.some((x) => busy.has(x) || isAway(x))) continue;
    if (v.visit_weekdays.length && dates.some((x) => !v.visit_weekdays.includes(isoWeekday(x)))) continue;
    let near: string | null = null;
    let nearMiles: number | null = null;
    for (const x of [addDays(dates[0], -1), addDays(dates[dates.length - 1], 1)]) {
      const b = busy.get(x);
      if (b && here && b.lat !== null && b.lng !== null) {
        const m = miles(here, { lat: b.lat, lng: b.lng });
        if (nearMiles === null || m < nearMiles) {
          nearMiles = m;
          near = b.client_name;
        }
      }
    }
    out.push({ start: d, dates, near, nearMiles });
  }
  out.sort((a, b) => {
    const an = a.nearMiles !== null && a.nearMiles <= 40 ? a.nearMiles : Infinity;
    const bn = b.nearMiles !== null && b.nearMiles <= 40 ? b.nearMiles : Infinity;
    return an - bn || a.start.localeCompare(b.start);
  });
  return out.slice(0, 8);
}

function responseChip(answer: string | null, note: string | null): SafeHtml {
  if (answer === "accepted") return html`<span class="chip good">Accepted</span>`;
  if (answer === "change") return html`<span class="chip bad">Asked for another date</span>${note ? html` <span class="small">"${note}"</span>` : ""}`;
  return html`<span class="chip warn">Not answered yet</span>`;
}

async function visitPage(v: VisitRow, warnings: string[], sendInvites = true): Promise<SafeHtml> {
  const [as, contacts, nearby, suggestions] = await Promise.all([
    assessors(),
    query("select name, job_title, email, phone from contacts where client_id = $1 order by is_primary desc, name", [v.client_id]),
    v.lat !== null && v.lng !== null
      ? query<VisitRow>(`${VISIT_SELECT} where v.status = 'to_book' and v.id <> $1 and c.lat is not null
           and abs((v.year * 12 + v.month) - $2) <= 1`, [v.id, v.year * 12 + v.month])
      : Promise.resolve([] as VisitRow[]),
    v.status === "done" || v.status === "cancelled" ? Promise.resolve([]) : suggestDates(v, v.assessor_id),
  ]);
  const here = v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : null;
  const close = here
    ? nearby.map((n) => ({ n, d: miles(here, { lat: n.lat!, lng: n.lng! }) })).filter((x) => x.d <= 25).sort((a, b) => a.d - b.d).slice(0, 8)
    : [];
  const dates = v.booked_on ? visitDates(v.booked_on, v.days, v.visit_weekdays) : [];
  return html`
<div class="spread"><div>
  <h1><a href="/clients/${v.client_id}">${v.client_name}</a></h1>
  <div class="muted">${v.visit_type ? html`<span class="chip">${VISIT_TYPES[v.visit_type]}</span> ` : ""}Visit ${v.seq}, due ${MONTHS[v.month - 1]} ${v.year} · ${v.days} day${v.days > 1 ? "s" : ""} · ${weekdaysText(v.visit_weekdays)}</div>
</div><a href="/visits?year=${v.year}&month=${v.month}">Back to planner</a></div>
${warnings.length ? html`<div class="error"><strong>Check before booking:</strong><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ""}
<div class="grid">
<section class="card">
  <h2>${VISIT_STATUS_LABEL[v.status]}${dates.length ? html`: ${dateRangeText(dates)}` : ""}</h2>
  <form method="post" action="/visits/${v.id}" class="stack">
    <label>Assessor <select name="assessor_id"><option value="">Not set</option>${as.filter((a) => a.active || a.id === v.assessor_id).map((a) => opt(a.id, a.name, v.assessor_id))}</select></label>
    <div class="fields">
      <label>First day <input type="date" name="booked_on" value="${v.booked_on ?? ""}"></label>
      <label>Arrival time <input name="booked_time" value="${v.booked_time ?? ""}" placeholder="e.g. 9:30"></label>
    </div>
    <label>Notes <textarea name="notes">${v.notes ?? ""}</textarea></label>
    ${v.status !== "done" ? html`<label class="inline"><input type="checkbox" name="send_invites" value="1"${checked(sendInvites)}> Email calendar invites to the assessor and the client</label>` : ""}
    ${warnings.length ? html`<input type="hidden" name="confirm" value="1">` : ""}
    <div class="row">
      ${v.status === "done" ? html`<button name="action" value="reopen" class="secondary">Not done after all</button>` : html`
      <button name="action" value="book">${warnings.length ? "Book anyway" : v.status === "booked" ? "Save booking" : "Book"}</button>
      <button name="action" value="save" class="secondary">Save notes only</button>
      ${v.status === "booked" ? html`<button name="action" value="unbook" class="secondary" data-confirm="Unbook this visit? Anyone invited gets a cancellation.">Unbook</button>` : ""}
      <button name="action" value="done" class="secondary">Mark done</button>
      ${v.status !== "cancelled" ? html`<button name="action" value="cancel" class="secondary" data-confirm="Cancel this visit? Anyone invited gets a cancellation.">Cancel visit</button>` : ""}`}
    </div>
  </form>
</section>
<section class="card">
  <h2>Invites</h2>
  ${v.status !== "booked" ? html`<p class="muted">Invites go out when the visit is booked.</p>`
    : !v.invited_at ? html`<p class="muted">No invites sent for this booking.</p>
      <form method="post" action="/visits/${v.id}"><button name="action" value="resend" class="small">Send invites now</button></form>`
    : html`<p class="small muted">Sent ${ukDate(v.invited_at)}</p>
      <ul class="list">
        <li><strong>${v.assessor_name ?? "Assessor"}</strong> <span class="small muted">${v.invite_assessor_email ?? "no email"}</span><br>${responseChip(v.assessor_response, v.assessor_response_note)}
          ${v.assessor_response !== "accepted" ? html`<form method="post" action="/visits/${v.id}" class="row small"><input type="hidden" name="who" value="assessor"><button name="action" value="accept_by_hand" class="small secondary">They accepted another way</button></form>` : ""}</li>
        <li><strong>${v.client_name}</strong> <span class="small muted">${v.invite_client_email ?? "no email"}</span><br>${responseChip(v.client_response, v.client_response_note)}
          ${v.client_response !== "accepted" ? html`<form method="post" action="/visits/${v.id}" class="row small"><input type="hidden" name="who" value="client"><button name="action" value="accept_by_hand" class="small secondary">They accepted another way</button></form>` : ""}</li>
      </ul>
      <form method="post" action="/visits/${v.id}"><button name="action" value="resend" class="small secondary">Send the invites again</button></form>`}
</section>
<section class="card">
  <h2>Who to contact</h2>
  ${v.phone ? html`<p>Main number: <a href="tel:${v.phone}">${v.phone}</a></p>` : ""}
  <ul class="list">${contacts.map((k) => html`<li><strong>${k.name}</strong>${k.job_title ? html` <span class="small muted">${k.job_title}</span>` : ""}
    ${k.phone ? html`<br><a href="tel:${k.phone}">${k.phone}</a>` : ""}${k.email ? html`<br><a href="mailto:${k.email}">${k.email}</a>` : ""}</li>`)}
  ${contacts.length === 0 ? html`<li class="muted">No contacts.</li>` : ""}</ul>
</section>
</div>
${v.status === "to_book" || v.status === "booked" ? html`<section class="card">
  <h2>Free dates in ${MONTHS[v.month - 1]} for ${v.assessor_name ?? "the assessor"}</h2>
  <p class="small muted">Days the client accepts, when the assessor isn't booked or away. Days next to their other visits nearby come first.</p>
  ${!v.assessor_id ? html`<p class="muted">Choose an assessor first.</p>` : ""}
  <ul class="list">${suggestions.map((sg) => html`<li class="spread" style="margin:0">
    <span>${dateRangeText(sg.dates)}${sg.near && sg.nearMiles !== null && sg.nearMiles <= 40 ? html` <span class="chip good">${Math.round(sg.nearMiles)} miles from ${sg.near}, booked next to it</span>` : ""}</span>
    <form method="post" action="/visits/${v.id}" class="row">
      <input type="hidden" name="assessor_id" value="${v.assessor_id ?? ""}"><input type="hidden" name="booked_on" value="${sg.start}">
      <input type="hidden" name="booked_time" value="${v.booked_time ?? ""}"><input type="hidden" name="notes" value="${v.notes ?? ""}">
      <input type="hidden" name="send_invites" value="1">
      <button name="action" value="book" class="small secondary">Book this${v.status === "booked" ? " instead" : ""}</button>
    </form></li>`)}
  ${v.assessor_id && suggestions.length === 0 ? html`<li class="muted">No free dates left this month.</li>` : ""}</ul>
</section>` : ""}
<section class="card">
  <h2>Book alongside: other visits to book within 25 miles</h2>
  ${!here ? html`<p class="muted">This client's postcode hasn't been placed on the map yet.</p>` : ""}
  <ul class="list">${close.map(({ n, d }) => html`<li><a href="/visits/${n.id}">${n.client_name}</a>
    <span class="small muted"> · ${Math.round(d)} miles · due ${MONTHS[n.month - 1]} · ${n.assessor_name ?? "no assessor"} · ${n.days} day${n.days > 1 ? "s" : ""}</span></li>`)}
  ${here && close.length === 0 ? html`<li class="muted">Nothing else nearby due this month or either side.</li>` : ""}</ul>
</section>`;
}
