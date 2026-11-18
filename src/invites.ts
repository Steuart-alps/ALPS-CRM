import { randomBytes } from "node:crypto";
import { Router } from "express";
import { one, query } from "./db.ts";
import { appUrl, sendMail } from "./email.ts";
import { buildIcs, parseTime } from "./ics.ts";
import { html, layout, ukDate, MONTHS } from "./html.ts";
import { s } from "./util.ts";
import { visitDates, dateRangeText } from "./routes/visits.ts";
import { VISIT_TYPES } from "./routes/clients.ts";

const token = () => randomBytes(24).toString("base64url");

function organizer(): { name: string; email: string } {
  const raw = process.env.INVITE_ORGANIZER_EMAIL || process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || "office@example.com";
  const email = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  return { name: "ALPS Consultancy", email: email.trim() };
}

type VisitForInvite = {
  id: number; client_id: number; seq: number; year: number; month: number; days: number; visit_type: string | null;
  booked_on: string | null; booked_time: string | null; invite_sequence: number; invited_at: string | null;
  invite_client_email: string | null; invite_assessor_email: string | null;
  client_token: string | null; assessor_token: string | null;
  client_name: string; address1: string | null; town: string | null; postcode: string | null; visit_weekdays: number[];
  assessor_name: string | null; assessor_email: string | null;
  contact_name: string | null; contact_email: string | null;
};

async function loadVisit(visitId: number): Promise<VisitForInvite | undefined> {
  return one<VisitForInvite>(
    `select v.*, c.name as client_name, c.address1, c.town, c.postcode, c.visit_weekdays,
            a.name as assessor_name, coalesce(a.email, u.email) as assessor_email,
            k.name as contact_name, k.email as contact_email
       from visits v join clients c on c.id = v.client_id
       left join assessors a on a.id = v.assessor_id left join users u on u.id = a.user_id
       left join lateral (select name, email from contacts k where k.client_id = c.id and k.email is not null
                           order by k.is_primary desc, k.id limit 1) k on true
      where v.id = $1`,
    [visitId],
  );
}

/**
 * Sends (or updates, or cancels) the calendar invite for a booked visit to
 * the assessor and the client's main contact. Answers are reset whenever the
 * dates change.
 */
export async function sendVisitInvites(visitId: number, mode: "book" | "cancel"): Promise<{ sent: string[]; missing: string[] }> {
  const v = await loadVisit(visitId);
  if (!v) return { sent: [], missing: [] };
  if (mode === "cancel" && !v.invited_at) return { sent: [], missing: [] };
  if (mode === "book" && !v.booked_on) return { sent: [], missing: [] };

  const sequence = v.invited_at ? v.invite_sequence + 1 : 0;
  const clientToken = v.client_token ?? token();
  const assessorToken = v.assessor_token ?? token();
  const clientEmail = mode === "cancel" ? v.invite_client_email : v.contact_email;
  const assessorEmail = mode === "cancel" ? v.invite_assessor_email : v.assessor_email;
  const dates = v.booked_on ? visitDates(v.booked_on, v.days, v.visit_weekdays) : [];
  const when = dateRangeText(dates);
  const time = parseTime(v.booked_time);
  const typeLabel = v.visit_type ? `${VISIT_TYPES[v.visit_type]} ` : "";
  const summary = `ALPS ${typeLabel}visit: ${v.client_name}`;
  const location = [v.address1, v.town, v.postcode].filter(Boolean).join(", ");
  const ics = (description: string) =>
    buildIcs({
      uid: `alps-visit-${v.id}@alps-crm`,
      sequence,
      method: mode === "cancel" ? "CANCEL" : "REQUEST",
      dates,
      time,
      summary,
      location,
      description,
      organizer: organizer(),
      attendees: [
        ...(assessorEmail ? [{ name: v.assessor_name ?? "Assessor", email: assessorEmail }] : []),
        ...(clientEmail ? [{ name: v.contact_name ?? v.client_name, email: clientEmail }] : []),
      ],
    });

  const sent: string[] = [];
  const missing: string[] = [];
  const people: { who: "client" | "assessor"; email: string | null; name: string; tok: string }[] = [
    { who: "assessor", email: assessorEmail, name: v.assessor_name ?? "the assessor", tok: assessorToken },
    { who: "client", email: clientEmail, name: v.contact_name ?? v.client_name, tok: clientToken },
  ];
  for (const p of people) {
    if (!p.email) {
      missing.push(p.who === "client" ? `${v.client_name} has no contact email` : `${p.name} has no email address`);
      continue;
    }
    const link = `${appUrl()}/respond/${p.tok}`;
    const first = p.name.split(" ")[0];
    const text =
      mode === "cancel"
        ? [`Hi ${first},`, "", `The ALPS ${typeLabel.toLowerCase()}visit at ${v.client_name} on ${when} has been cancelled.`, "", "ALPS Consultancy"].join("\n")
        : [
            `Hi ${first},`,
            "",
            `${sequence > 0 ? "The date has changed for" : "This is"} the ALPS ${typeLabel.toLowerCase()}visit at ${v.client_name}:`,
            "",
            when + (time ? `, arriving ${v.booked_time}` : ""),
            v.days > 1 ? `${v.days} days` : "",
            location,
            p.who === "client" && v.assessor_name ? `Consultant: ${v.assessor_name}` : "",
            "",
            "Please accept or ask for another date here:",
            link,
            "",
            "The calendar invite is attached.",
            "",
            "ALPS Consultancy",
          ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");
    const ok = await sendMail({
      to: p.email,
      subject: mode === "cancel" ? `Cancelled: ${summary}` : `${sequence > 0 ? "Changed: " : ""}${summary}, ${when}`,
      text,
      attachments: [{ filename: "visit.ics", content: ics(mode === "cancel" ? "Cancelled" : `Accept or ask for another date: ${link}`), contentType: `text/calendar; method=${mode === "cancel" ? "CANCEL" : "REQUEST"}` }],
    });
    sent.push(p.email + (ok ? "" : " (email not set up yet, so not actually sent)"));
  }

  if (mode === "cancel") {
    await query(
      `update visits set invited_at = null, invite_sequence = $2, client_response = null, client_response_at = null, client_response_note = null,
         assessor_response = null, assessor_response_at = null, assessor_response_note = null where id = $1`,
      [v.id, sequence],
    );
  } else {
    await query(
      `update visits set invited_at = now(), invite_sequence = $2, invite_client_email = $3, invite_assessor_email = $4,
         client_token = $5, assessor_token = $6,
         client_response = null, client_response_at = null, client_response_note = null,
         assessor_response = null, assessor_response_at = null, assessor_response_note = null where id = $1`,
      [v.id, sequence, clientEmail, assessorEmail, clientToken, assessorToken],
    );
  }
  return { sent, missing };
}

/** Public pages behind the links in invite emails. No sign-in needed. */
export function respondRouter(): Router {
  const r = Router();

  const find = async (tok: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) return null;
    const v = await one(
      `select v.*, c.name as client_name, a.name as assessor_name, c.visit_weekdays from visits v join clients c on c.id = v.client_id
         left join assessors a on a.id = v.assessor_id
        where (v.client_token = $1 or v.assessor_token = $1) and v.status = 'booked'`,
      [tok],
    );
    if (!v) return null;
    return { v, who: v.client_token === tok ? ("client" as const) : ("assessor" as const) };
  };

  const shell = (body: ReturnType<typeof html>) =>
    layout({ title: "ALPS visit", body: html`<div class="login card" style="max-width:520px">${body}</div>` });

  r.get("/respond/:token", async (req, res) => {
    const f = await find(req.params.token);
    if (!f) return res.status(404).send(shell(html`<h1>This link has expired</h1><p>The visit may have moved or been cancelled. Please contact ALPS Consultancy.</p>`));
    const { v, who } = f;
    const answer = who === "client" ? v.client_response : v.assessor_response;
    res.send(shell(html`
<h1>ALPS visit at ${v.client_name}</h1>
<p><strong>${dateRangeText(visitDates(v.booked_on, v.days, v.visit_weekdays))}</strong>${v.booked_time ? html`, arriving ${v.booked_time}` : ""}${v.visit_type ? html`<br>${VISIT_TYPES[v.visit_type]} visit` : ""}${who === "client" && v.assessor_name ? html`<br>Consultant: ${v.assessor_name}` : ""}</p>
${answer ? html`<p class="flash">${answer === "accepted" ? "You've accepted this visit. Thank you." : "You've asked for another date. We'll be in touch."}</p>` : ""}
<form method="post" action="/respond/${req.params.token}" class="stack">
  <button name="answer" value="accepted">Accept this visit</button>
  <details${answer === "change" ? " open" : ""}><summary>Ask for another date</summary>
    <div class="stack" style="margin-top:.5rem">
      <label>Which dates would suit you better? <textarea name="note" placeholder="e.g. Any Wednesday in March"></textarea></label>
      <button name="answer" value="change" class="secondary">Ask for another date</button>
    </div>
  </details>
</form>`));
  });

  r.post("/respond/:token", async (req, res) => {
    const f = await find(req.params.token);
    if (!f) return res.status(404).send(shell(html`<h1>This link has expired</h1>`));
    const { v, who } = f;
    const answer = req.body.answer === "change" ? "change" : "accepted";
    const note = s(req.body.note);
    const col = who === "client" ? "client" : "assessor";
    await query(`update visits set ${col}_response = $2, ${col}_response_at = now(), ${col}_response_note = $3 where id = $1`, [v.id, answer, note]);
    const whoName = who === "client" ? v.client_name : v.assessor_name ?? "The assessor";
    await query("insert into activities (client_id, kind, body) values ($1, 'visit', $2)", [
      v.client_id,
      answer === "accepted"
        ? `${whoName} accepted the visit on ${ukDate(v.booked_on)}.`
        : `${whoName} asked for another date for the visit on ${ukDate(v.booked_on)}${note ? `: ${note}` : ""}.`,
    ]);
    if (answer === "change") {
      // Rebooking is a job for the office: it goes on a staff member's task list.
      const staff = await one<{ id: number }>("select id from users where active and (office or role = 'staff') order by office desc, id limit 1");
      const owner = await one<{ id: number }>("select id from users where active and role = 'owner' order by id limit 1");
      await query("insert into tasks (client_id, title, details, assigned_to, created_by, due_on) values ($1, $2, $3, $4, null, current_date + 1)", [
        v.client_id,
        `Rebook ${MONTHS[v.month - 1]} visit for ${v.client_name}`,
        `${whoName} asked for another date${note ? `: ${note}` : "."}\nVisit: ${appUrl()}/visits/${v.id}`,
        staff?.id ?? owner?.id ?? null,
      ]);
    }
    res.redirect(`/respond/${req.params.token}`);
  });

  return r;
}
