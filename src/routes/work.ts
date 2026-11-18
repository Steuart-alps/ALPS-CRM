// Tasks, paperwork chasers and ComplyTrack populate jobs.
import { Router } from "express";
import { one, query } from "../db.ts";
import { html, ukDate, todayUk, opt } from "../html.ts";
import { s, int, dateOrNull, idParam, page, NotFound, back } from "../util.ts";
import { setFlash } from "../auth.ts";
import { officeUser, activeUsers } from "../lookups.ts";
import { notifyAssigned } from "../notify.ts";

export const COMPLYTRACK_URL = process.env.COMPLYTRACK_URL || "https://complytrack.alpsconsultancy.co.uk";

export const DEFAULT_POPULATE_DOCS = [
  "Owner gives the preparer onboarding access in ComplyTrack (Clients page, person icon)",
  "Health & safety policy",
  "Fire risk assessment",
  "General risk assessments",
  "COSHH assessments",
  "Safe operating procedures",
  "Staff training records",
  "Contractor list and certificates",
  "Equipment and PAT register",
];

export function workRouter(): Router {
  const r = Router();

  // ---- Tasks ----
  r.get("/tasks", async (req, res) => {
    const view = typeof req.query.view === "string" ? req.query.view : "mine";
    const where =
      view === "mine" ? "t.assigned_to = $1 and t.status = 'open'"
      : view === "set" ? "t.created_by = $1 and t.status = 'open'"
      : view === "done" ? "t.status = 'done' and $1::int is not null"
      : "t.status = 'open' and $1::int is not null";
    const [rows, users, clients] = await Promise.all([
      query(
        `select t.*, c.name as client_name, u.name as assignee, cb.name as setter, db.name as doer
           from tasks t left join clients c on c.id = t.client_id
           left join users u on u.id = t.assigned_to left join users cb on cb.id = t.created_by left join users db on db.id = t.done_by
          where ${where}
          order by ${view === "done" ? "t.done_at desc" : "t.due_on nulls last, t.id"} limit 300`,
        [req.user!.id],
      ),
      activeUsers(),
      query("select id, name from clients where status <> 'former' order by lower(name)"),
    ]);
    const today = todayUk();
    const tab = (k: string, label: string) => html`<a class="button ${view === k ? "" : "secondary"} small" href="/tasks?view=${k}">${label}</a>`;
    const staff = officeUser(users);
    page(req, res, "Tasks", html`
<div class="spread"><h1>Tasks</h1><div class="row">${tab("mine", "My tasks")}${tab("set", "Tasks I've set")}${tab("all", "Everyone's open tasks")}${tab("done", "Done")}</div></div>
<ul class="list card">${rows.map((t) => html`<li>
  <div class="spread" style="margin:0">
    <div>
      ${t.status === "done" ? html`<s>${t.title}</s>` : html`<strong>${t.title}</strong>`}
      ${t.client_name ? html` · <a href="/clients/${t.client_id}">${t.client_name}</a>` : ""}
      <div class="small muted">For ${t.assignee ?? "nobody"} · set by ${t.setter ?? "?"}${t.due_on ? html` · due <span class="${t.status === "open" && t.due_on < today ? "overdue" : ""}">${ukDate(t.due_on)}</span>` : ""}
        ${t.status === "done" ? html` · done by ${t.doer ?? "?"} ${ukDate(t.done_at)}${t.done_note ? html`: ${t.done_note}` : ""}` : ""}</div>
      ${t.details ? html`<div class="small" style="white-space:pre-wrap">${t.details}</div>` : ""}
    </div>
    ${t.status === "open" ? html`<form method="post" action="/tasks/${t.id}/done" class="row">
      <input name="done_note" placeholder="Note (optional)" aria-label="Note" style="width:12rem">
      <button class="small">Done</button></form>`
      : html`<form method="post" action="/tasks/${t.id}/reopen"><button class="small secondary">Reopen</button></form>`}
  </div></li>`)}
  ${rows.length === 0 ? html`<li class="muted">Nothing here.</li>` : ""}</ul>
<section class="card">
  <h2>Set a task</h2>
  <form method="post" action="/tasks" class="stack">
    <input name="title" placeholder="What needs doing" required aria-label="Task">
    <textarea name="details" placeholder="Details (optional)" aria-label="Details"></textarea>
    <div class="fields">
      <label>For <select name="assigned_to">${users.map((u) => opt(u.id, u.name, staff?.id ?? req.user!.id))}</select></label>
      <label>Client (optional) <select name="client_id"><option value="">None</option>${clients.map((c) => opt(c.id, c.name, null))}</select></label>
      <label>Due <input type="date" name="due_on"></label>
    </div>
    <div><button>Set task</button></div>
  </form>
</section>`, "tasks");
  });

  r.post("/tasks", async (req, res) => {
    const title = s(req.body.title);
    if (!title) return res.redirect(back(req, "/tasks"));
    const assignedTo = int(req.body.assigned_to);
    const clientId = int(req.body.client_id);
    const dueOn = dateOrNull(req.body.due_on);
    const row = await one<{ id: number }>(
      "insert into tasks (client_id, title, details, assigned_to, created_by, due_on) values ($1,$2,$3,$4,$5,$6) returning id",
      [clientId, title, s(req.body.details), assignedTo, req.user!.id, dueOn],
    );
    await notifyAssigned({ assigneeId: assignedTo, byUserId: req.user!.id, kind: "task", title, clientId, dueOn, path: "/tasks" });
    setFlash(req, "Task set.");
    res.redirect(back(req, "/tasks"));
    void row;
  });

  r.post("/tasks/:id/done", async (req, res) => {
    const t = await one("update tasks set status = 'done', done_at = now(), done_by = $2, done_note = $3 where id = $1 returning client_id, title", [
      idParam(req), req.user!.id, s(req.body.done_note),
    ]);
    if (!t) throw new NotFound();
    if (t.client_id) {
      await query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', $3)", [
        t.client_id, req.user!.id, `Task done: ${t.title}${s(req.body.done_note) ? ` (${s(req.body.done_note)})` : ""}`,
      ]);
    }
    res.redirect(back(req, "/tasks"));
  });

  r.post("/tasks/:id/reopen", async (req, res) => {
    await query("update tasks set status = 'open', done_at = null, done_by = null, done_note = null where id = $1", [idParam(req)]);
    res.redirect(back(req, "/tasks"));
  });

  // ---- Paperwork chasers ----
  r.get("/chasers", async (req, res) => {
    const rows = await query(
      `select ch.*, c.name as client_name from chasers ch join clients c on c.id = ch.client_id
        where ch.received_on is null order by coalesce(ch.chase_again_on, ch.requested_on), ch.id`,
    );
    const today = todayUk();
    page(req, res, "Chasers", html`
<h1>Paperwork being chased <span class="muted small">(${rows.length})</span></h1>
<p class="muted small">Add a chaser from a client's page. When something arrives, mark it received.</p>
<div class="table-wrap"><table>
<thead><tr><th>What</th><th>Client</th><th>Asked</th><th>Chase again</th><th></th></tr></thead>
<tbody>${rows.map((ch) => html`<tr>
  <td>${ch.item}${ch.notes ? html`<br><span class="small muted">${ch.notes}</span>` : ""}</td>
  <td><a href="/clients/${ch.client_id}">${ch.client_name}</a></td>
  <td>${ukDate(ch.requested_on)}</td>
  <td>${ch.chase_again_on ? html`<span class="${ch.chase_again_on <= today ? "overdue" : ""}">${ukDate(ch.chase_again_on)}</span>` : ""}</td>
  <td><form method="post" action="/chasers/${ch.id}/chased" class="row">
      <input type="date" name="chase_again_on" aria-label="Chase again on" style="width:10rem">
      <button class="small secondary">Chased</button></form>
    <form method="post" action="/chasers/${ch.id}/received"><button class="small">Received</button></form></td>
</tr>`)}
${rows.length === 0 ? html`<tr><td colspan="5" class="muted">Nothing outstanding.</td></tr>` : ""}</tbody></table></div>`, "chasers");
  });

  r.post("/chasers/:id/received", async (req, res) => {
    const ch = await one("update chasers set received_on = current_date where id = $1 returning client_id, item", [idParam(req)]);
    if (!ch) throw new NotFound();
    await query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', $3)", [ch.client_id, req.user!.id, `Received: ${ch.item}`]);
    res.redirect(back(req, "/chasers"));
  });

  r.post("/chasers/:id/chased", async (req, res) => {
    const ch = await one("update chasers set chase_again_on = $2 where id = $1 returning client_id, item", [idParam(req), dateOrNull(req.body.chase_again_on)]);
    if (!ch) throw new NotFound();
    await query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'email', $3)", [ch.client_id, req.user!.id, `Chased: ${ch.item}`]);
    res.redirect(back(req, "/chasers"));
  });

  // ---- ComplyTrack populate jobs ----
  r.get("/populate", async (req, res) => {
    const rows = await query(
      `select j.*, c.name as client_name, u.name as assignee,
              (select count(*)::int from populate_items i where i.job_id = j.id) as total,
              (select count(*)::int from populate_items i where i.job_id = j.id and i.done_at is not null) as done
         from populate_jobs j join clients c on c.id = j.client_id left join users u on u.id = j.assigned_to
        order by (j.status = 'done'), j.created_at desc`,
    );
    page(req, res, "Populate jobs", html`
<div class="spread"><h1>ComplyTrack populate jobs</h1><a class="button" href="/populate/new">New populate job</a></div>
<p class="muted small">The one-off service where ALPS loads a ComplyTrack customer's documents for them.</p>
<div class="table-wrap"><table><thead><tr><th>Job</th><th>Client</th><th>Who</th><th>Progress</th><th>Status</th></tr></thead>
<tbody>${rows.map((j) => html`<tr><td><a href="/populate/${j.id}">${j.title}</a></td><td><a href="/clients/${j.client_id}">${j.client_name}</a></td>
  <td>${j.assignee ?? ""}</td><td>${j.done} of ${j.total}</td><td>${j.status === "done" ? html`<span class="chip good">Done</span>` : j.status === "checking" ? html`<span class="chip warn">Checking</span>` : html`<span class="chip">In progress</span>`}</td></tr>`)}
${rows.length === 0 ? html`<tr><td colspan="5" class="muted">No populate jobs yet.</td></tr>` : ""}</tbody></table></div>`, "populate");
  });

  r.get("/populate/new", async (req, res) => {
    const [clients, users] = await Promise.all([
      query("select id, name, complytrack from clients where status <> 'former' order by complytrack desc, lower(name)"),
      activeUsers(),
    ]);
    const staff = officeUser(users);
    page(req, res, "New populate job", html`<h1>New populate job</h1>
<form method="post" action="/populate" class="stack card">
  <div class="fields">
    <label>Client <select name="client_id" required><option value="">Choose…</option>${clients.map((c) => opt(c.id, c.name + (c.complytrack ? " (ComplyTrack)" : ""), int(req.query.client)))}</select></label>
    <label>Who does it <select name="assigned_to">${users.map((u) => opt(u.id, u.name, staff?.id ?? req.user!.id))}</select></label>
  </div>
  <label>Documents to load, one per line <textarea name="items" rows="9">${DEFAULT_POPULATE_DOCS.join("\n")}</textarea></label>
  <label>Notes <textarea name="notes"></textarea></label>
  <div><button>Create job</button></div>
</form>`, "populate");
  });

  r.post("/populate", async (req, res) => {
    const clientId = int(req.body.client_id);
    if (!clientId) return res.redirect("/populate/new");
    const c = await one<{ name: string }>("select name from clients where id = $1", [clientId]);
    if (!c) throw new NotFound();
    const assignedTo = int(req.body.assigned_to);
    const job = await one<{ id: number }>(
      "insert into populate_jobs (client_id, title, assigned_to, notes) values ($1, $2, $3, $4) returning id",
      [clientId, `Populate ComplyTrack for ${c.name}`, assignedTo, s(req.body.notes)],
    );
    const items = String(req.body.items ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const [i, doc] of items.entries()) {
      await query("insert into populate_items (job_id, document, sort_order) values ($1, $2, $3)", [job!.id, doc, i]);
    }
    await query("update clients set complytrack = true where id = $1", [clientId]);
    await notifyAssigned({ assigneeId: assignedTo, byUserId: req.user!.id, kind: "task", title: `Populate ComplyTrack for ${c.name}`, clientId, dueOn: null, path: `/populate/${job!.id}` });
    res.redirect(`/populate/${job!.id}`);
  });

  r.get("/populate/:id", async (req, res) => {
    const id = idParam(req);
    const j = await one("select j.*, c.name as client_name from populate_jobs j join clients c on c.id = j.client_id where j.id = $1", [id]);
    if (!j) throw new NotFound();
    const items = await query(
      "select i.*, u.name as doer from populate_items i left join users u on u.id = i.done_by where i.job_id = $1 order by i.sort_order, i.id",
      [id],
    );
    const done = items.filter((i) => i.done_at).length;
    page(req, res, j.title, html`
<div class="spread"><div><h1>${j.title}</h1><div class="muted"><a href="/clients/${j.client_id}">${j.client_name}</a> · ${done} of ${items.length} loaded</div></div>
<a href="/populate">All populate jobs</a></div>
<p class="card small">Prepare each document, then upload it in ComplyTrack under this business (Documents, or Upload your lists) and tick it off here.
  <a class="button small secondary" href="${COMPLYTRACK_URL}" target="_blank" rel="noopener">Open ComplyTrack</a></p>
${j.notes ? html`<p class="card" style="white-space:pre-wrap">${j.notes}</p>` : ""}
<ul class="list card">${items.map((i) => html`<li class="spread" style="margin:0">
  <span>${i.done_at ? html`<s>${i.document}</s> <span class="small muted">loaded by ${i.doer ?? "?"} ${ukDate(i.done_at)}</span>` : i.document}</span>
  <form method="post" action="/populate/items/${i.id}/toggle"><button class="small ${i.done_at ? "secondary" : ""}">${i.done_at ? "Undo" : "Loaded"}</button></form>
</li>`)}</ul>
<form method="post" action="/populate/${id}/items" class="row card">
  <input name="document" placeholder="Add another document" required aria-label="Document" style="flex:1"><button class="small">Add</button>
</form>
<form method="post" action="/populate/${id}/status" class="row">
  ${j.status === "open" ? html`<button name="status" value="checking"${done === items.length ? "" : " disabled"}>Everything loaded: ready for checking</button>` : ""}
  ${j.status === "checking" && req.user!.role === "owner" ? html`<button name="status" value="done">Checked: job done</button><button name="status" value="open" class="secondary">Needs more work</button>` : ""}
  ${j.status === "done" ? html`<span class="chip good">Done ${ukDate(j.completed_at)}</span>` : ""}
</form>`, "populate");
  });

  r.post("/populate/:id/items", async (req, res) => {
    const id = idParam(req);
    const doc = s(req.body.document);
    if (doc) await query("insert into populate_items (job_id, document, sort_order) values ($1, $2, 1000)", [id, doc]);
    res.redirect(`/populate/${id}`);
  });

  r.post("/populate/items/:id/toggle", async (req, res) => {
    const i = await one(
      `update populate_items set done_at = case when done_at is null then now() end,
         done_by = case when done_at is null then $2::int end where id = $1 returning job_id`,
      [idParam(req), req.user!.id],
    );
    if (!i) throw new NotFound();
    res.redirect(`/populate/${i.job_id}`);
  });

  r.post("/populate/:id/status", async (req, res) => {
    const id = idParam(req);
    const st = String(req.body.status);
    if (st === "done" && req.user!.role !== "owner") return res.redirect(`/populate/${id}`);
    if (!["open", "checking", "done"].includes(st)) return res.redirect(`/populate/${id}`);
    const j = await one("update populate_jobs set status = $2, completed_at = case when $2 = 'done' then now() end where id = $1 returning client_id, title", [id, st]);
    if (j && st === "done") {
      await query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', $3)", [j.client_id, req.user!.id, `${j.title}: done`]);
    }
    res.redirect(`/populate/${id}`);
  });

  return r;
}
