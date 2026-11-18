// "Missing details": the gaps in client records for the office to fill in.
// Prices are deliberately not part of this list (they are the owner's).
import { Router } from "express";
import { one, query } from "../db.ts";
import { html, todayUk, ukDate } from "../html.ts";
import { s, int, dateOrNull, page } from "../util.ts";
import { setFlash } from "../auth.ts";
import { activeUsers, officeUser } from "../lookups.ts";
import { notifyAssigned } from "../notify.ts";
import { appUrl } from "../email.ts";

export const GAP_CHECKS: { key: string; label: string; sql: string }[] = [
  { key: "contact", label: "No contact", sql: "not exists (select 1 from contacts k where k.client_id = c.id)" },
  { key: "email", label: "No contact email", sql: "not exists (select 1 from contacts k where k.client_id = c.id and k.email is not null)" },
  { key: "phone", label: "No phone number", sql: "c.phone is null and not exists (select 1 from contacts k where k.client_id = c.id and k.phone is not null)" },
  { key: "postcode", label: "No postcode", sql: "c.postcode is null" },
  { key: "legal", label: "No legal name", sql: "c.legal_name is null" },
  { key: "start", label: "No contract start date", sql: "c.contract_start is null" },
  { key: "visits", label: "No visit months", sql: "cardinality(c.visit_months) = 0" },
  { key: "types", label: "Visit types not set", sql: "cardinality(c.visit_months) > 0 and (cardinality(c.visit_types) < cardinality(c.visit_months) or '' = any(c.visit_types))" },
  { key: "assessor", label: "No usual assessor", sql: "c.assessor_id is null" },
  { key: "type", label: "No type of business", sql: "c.business_type is null" },
];

export type Completion = { clients: number; clientsWithGaps: number; filled: number; possible: number; pct: number };

/** How complete the active clients' records are: details present out of details checked. */
export async function completion(): Promise<Completion> {
  const row = await one<{ clients: number; with_gaps: number; missing: number }>(
    `select count(*)::int as clients,
            count(*) filter (where ${GAP_CHECKS.map((g) => `(${g.sql})`).join(" or ")})::int as with_gaps,
            (${GAP_CHECKS.map((g) => `count(*) filter (where ${g.sql})`).join(" + ")})::int as missing
       from clients c where c.status = 'client'`,
  );
  const clients = row?.clients ?? 0;
  const possible = clients * GAP_CHECKS.length;
  const filled = possible - (row?.missing ?? 0);
  return { clients, clientsWithGaps: row?.with_gaps ?? 0, filled, possible, pct: possible ? Math.floor((filled / possible) * 100) : 100 };
}

/** Saves today's figures (one row a day, updated through the day). */
export async function recordCompletion(c?: Completion): Promise<Completion> {
  const now = c ?? (await completion());
  await query(
    `insert into completion_daily (day, clients, clients_with_gaps, filled, possible) values ($1, $2, $3, $4, $5)
     on conflict (day) do update set clients = $2, clients_with_gaps = $3, filled = $4, possible = $5`,
    [todayUk(), now.clients, now.clientsWithGaps, now.filled, now.possible],
  );
  return now;
}

export function progressBar(pct: number) {
  return html`<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
}

const TASK_TITLE = "Complete the client database";

export function gapsRouter() {
  const r = Router();
  r.get("/gaps", async (req, res) => {
    const only = typeof req.query.only === "string" ? GAP_CHECKS.find((g) => g.key === req.query.only) : undefined;
    const cols = GAP_CHECKS.map((g) => `(${g.sql}) as "${g.key}"`).join(", ");
    const rows = await query(
      `select c.id, c.name, ${cols} from clients c where c.status = 'client'
         and (${(only ? [only] : GAP_CHECKS).map((g) => `(${g.sql})`).join(" or ")}) order by lower(c.name)`,
    );
    const counts = GAP_CHECKS.map((g) => ({ g, n: rows.filter((r2) => r2[g.key]).length }));
    const now = await recordCompletion();
    const weekAgo = await one<{ day: string; clients_with_gaps: number; filled: number; possible: number }>(
      "select * from completion_daily where day <= $1::date - 7 order by day desc limit 1", [todayUk()],
    );
    const before = weekAgo && weekAgo.possible ? Math.floor((weekAgo.filled / weekAgo.possible) * 100) : null;
    const [users, task] = await Promise.all([
      activeUsers(),
      one<{ id: number; assigned_name: string | null; created_at: string; due_on: string | null }>(
        `select t.id, u.name as assigned_name, t.created_at::date::text as created_at, t.due_on from tasks t
           left join users u on u.id = t.assigned_to where t.title = $1 and t.status = 'open' order by t.id desc limit 1`, [TASK_TITLE]),
    ]);
    const office = officeUser(users);
    page(req, res, "Missing details", html`
<h1>Missing details <span class="muted small">(${rows.length} clients)</span></h1>
<section class="card" style="margin-bottom:1rem">
  <div class="spread"><h2>Client database ${now.pct}% complete</h2>
    <span class="small muted">${now.filled} of ${now.possible} details across ${now.clients} active clients</span></div>
  ${progressBar(now.pct)}
  <p class="small">${now.clientsWithGaps === 0 ? "Every active client's record is complete." : `${now.clientsWithGaps} client${now.clientsWithGaps === 1 ? "" : "s"} still have something missing.`}
    ${before !== null ? ` A week ago it was ${before}% with ${weekAgo!.clients_with_gaps} clients to finish.` : ""}</p>
  ${task
    ? html`<p class="small"><span class="chip good">Task set</span> ${task.assigned_name ?? "Nobody"} has this as a task since ${ukDate(task.created_at)}${task.due_on ? `, due ${ukDate(task.due_on)}` : ""}. It is ticked off on the Tasks page.</p>`
    : now.clientsWithGaps > 0 ? html`<form method="post" action="/gaps/task" class="row">
    <label>Give this to <select name="assigned_to">${users.map((u) => html`<option value="${u.id}" ${u.id === office?.id ? "selected" : ""}>${u.name}</option>`)}</select></label>
    <label>Finish by <input type="date" name="due_on"></label>
    <button>Set as a task</button>
  </form>` : ""}
</section>
<p class="small muted">Work through these to complete each client's record. Open a client, then Edit. Prices are not part of this list.</p>
<div class="row" style="margin-bottom:1rem">
  <a class="button small ${only ? "secondary" : ""}" href="/gaps">Everything</a>
  ${counts.filter((c) => c.n || only?.key === c.g.key).map((c) => html`<a class="button small ${only?.key === c.g.key ? "" : "secondary"}" href="/gaps?only=${c.g.key}">${c.g.label} (${c.n})</a>`)}
</div>
<div class="table-wrap"><table><thead><tr><th>Client</th><th>What's missing</th></tr></thead><tbody>
${rows.map((c) => html`<tr><td><a href="/clients/${c.id}">${c.name}</a> · <a class="small" href="/clients/${c.id}/edit">Edit</a></td>
  <td>${GAP_CHECKS.filter((g) => c[g.key]).map((g) => html`<span class="chip warn">${g.label}</span>`)}</td></tr>`)}
${rows.length === 0 ? html`<tr><td colspan="2" class="muted">Every client record is complete.</td></tr>` : ""}
</tbody></table></div>`, "clients");
  });
  r.post("/gaps/task", async (req, res) => {
    const assignedTo = int(req.body.assigned_to);
    const dueOn = dateOrNull(req.body.due_on);
    const now = await completion();
    const existing = await one("select id from tasks where title = $1 and status = 'open'", [TASK_TITLE]);
    if (!existing) {
      await query("insert into tasks (title, details, assigned_to, created_by, due_on) values ($1, $2, $3, $4, $5)", [
        TASK_TITLE,
        `Fill in the missing details on ${appUrl()}/gaps (${now.clientsWithGaps} clients, ${now.pct}% complete when set). Contacts, emails, phone numbers, legal names, contract start dates, visit months and types, usual assessor and type of business. ${s(req.body.details) ?? ""}`.trim(),
        assignedTo, req.user!.id, dueOn,
      ]);
      await notifyAssigned({ assigneeId: assignedTo, byUserId: req.user!.id, kind: "task", title: TASK_TITLE, clientId: null, dueOn, path: "/gaps" });
    }
    setFlash(req, existing ? "That task is already set." : "Task set.");
    res.redirect("/gaps");
  });

  return r;
}
