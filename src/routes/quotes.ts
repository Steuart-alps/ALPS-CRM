import { Router } from "express";
import { one, query } from "../db.ts";
import { html, ukDate, todayUk, money, moneyInput, parseMoney, opt } from "../html.ts";
import { s, int, dateOrNull, idParam, page, NotFound } from "../util.ts";
import { setFlash } from "../auth.ts";
import { priceItems } from "../lookups.ts";

export const QUOTE_STATUS: Record<string, string> = {
  draft: "Being prepared",
  ready: "Waiting for prices and approval",
  approved: "Approved, not sent yet",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
};

export function quotesRouter(): Router {
  const r = Router();

  r.get("/quotes", async (req, res) => {
    const isOwner = req.user!.role === "owner";
    const rows = await query(
      `select q.*, c.name as client_name, c.status as client_status, u.name as preparer,
              (select coalesce(sum(monthly_pence), 0)::int from quote_lines l where l.quote_id = q.id) as monthly,
              (select coalesce(sum(annual_pence), 0)::int from quote_lines l where l.quote_id = q.id) as annual
         from quotes q join clients c on c.id = q.client_id left join users u on u.id = q.prepared_by
        order by (q.status in ('accepted', 'declined')), q.updated_at desc limit 300`,
    );
    const prospects = await query("select id, name from clients where status = 'prospect' order by lower(name)");
    page(req, res, "Quotes", html`
<div class="spread"><h1>Quotes</h1>
<form method="get" action="/quotes/new" class="row"><select name="client" required aria-label="Prospect"><option value="">Quote for…</option>${prospects.map((p) => opt(p.id, p.name, null))}</select><button>New quote</button>
<a class="small" href="/clients/new?status=prospect">Add a prospect</a></form></div>
<div class="table-wrap"><table><thead><tr><th>Quote</th><th>For</th><th>Prepared by</th>${isOwner ? html`<th>Monthly</th><th>Annual</th>` : ""}<th>Status</th></tr></thead>
<tbody>${rows.map((q) => html`<tr><td><a href="/quotes/${q.id}">Quote ${q.id}</a><br><span class="small muted">${ukDate(q.created_at)}</span></td>
  <td><a href="/clients/${q.client_id}">${q.client_name}</a></td><td>${q.preparer ?? ""}</td>
  ${isOwner ? html`<td>${q.monthly ? money(q.monthly) : ""}</td><td>${q.annual ? money(q.annual) : ""}</td>` : ""}
  <td>${QUOTE_STATUS[q.status]}</td></tr>`)}
${rows.length === 0 ? html`<tr><td colspan="6" class="muted">No quotes yet.</td></tr>` : ""}</tbody></table></div>`, "quotes");
  });

  r.get("/quotes/new", async (req, res) => {
    const clientId = int(req.query.client);
    if (!clientId) return res.redirect("/quotes");
    const c = await one("select id from clients where id = $1", [clientId]);
    if (!c) throw new NotFound();
    const q = await one<{ id: number }>("insert into quotes (client_id, prepared_by) values ($1, $2) returning id", [clientId, req.user!.id]);
    res.redirect(`/quotes/${q!.id}`);
  });

  r.get("/quotes/:id", async (req, res) => {
    const id = idParam(req);
    const q = await one(
      `select q.*, c.name as client_name, c.status as client_status, u.name as preparer, a.name as approver
         from quotes q join clients c on c.id = q.client_id
         left join users u on u.id = q.prepared_by left join users a on a.id = q.approved_by where q.id = $1`,
      [id],
    );
    if (!q) throw new NotFound();
    const [lines, items] = await Promise.all([
      query("select * from quote_lines where quote_id = $1 order by sort_order, id", [id]),
      priceItems(),
    ]);
    const isOwner = req.user!.role === "owner";
    const editable = q.status === "draft" || (isOwner && q.status === "ready");
    const monthly = lines.reduce((t, l) => t + (l.monthly_pence ?? 0), 0);
    const annual = lines.reduce((t, l) => t + (l.annual_pence ?? 0), 0);
    page(req, res, `Quote ${id}`, html`
<div class="spread"><div><h1>Quote ${id} for <a href="/clients/${q.client_id}">${q.client_name}</a></h1>
<div class="muted">${QUOTE_STATUS[q.status]} · prepared by ${q.preparer ?? "?"}${q.approver ? ` · approved by ${q.approver} ${ukDate(q.approved_at)}` : ""}${q.sent_on ? ` · sent ${ukDate(q.sent_on)}` : ""}</div></div>
<a href="/quotes">All quotes</a></div>
${q.review_note && q.status === "draft" ? html`<p class="error"><strong>Sent back:</strong> ${q.review_note}</p>` : ""}
<section class="card">
  <h2>What's included</h2>
  <form method="post" action="/quotes/${id}/lines" class="stack">
  <div class="table-wrap"><table><thead><tr><th>Service</th>${isOwner ? html`<th>Monthly (£)</th><th>Annual (£)</th>` : ""}<th></th></tr></thead>
  <tbody>${lines.map((l) => html`<tr>
    <td>${editable ? html`<input name="desc_${l.id}" value="${l.description}" aria-label="Service">` : l.description}</td>
    ${isOwner ? html`<td>${editable ? html`<input name="monthly_${l.id}" value="${moneyInput(l.monthly_pence)}" inputmode="decimal" aria-label="Monthly">` : money(l.monthly_pence)}</td>
    <td>${editable ? html`<input name="annual_${l.id}" value="${moneyInput(l.annual_pence)}" inputmode="decimal" aria-label="Annual">` : money(l.annual_pence)}</td>` : ""}
    <td>${editable ? html`<button name="remove" value="${l.id}" class="small secondary">Remove</button>` : ""}</td></tr>`)}
  ${lines.length === 0 ? html`<tr><td colspan="4" class="muted">Nothing added yet.</td></tr>` : ""}
  ${isOwner && lines.length ? html`<tr><th>Total</th><th>${money(monthly)}</th><th>${money(annual)}</th><th></th></tr>` : ""}</tbody></table></div>
  ${editable ? html`<div class="fields">
    <label>Add from the price list <select name="add_item"><option value="">Choose…</option>${items.filter((i) => i.active).map((i) => opt(i.id, i.name, null))}</select></label>
    <label>Or something else <input name="add_custom" placeholder="e.g. Two-day initial audit"></label>
  </div>
  <div><button class="secondary">Save</button></div>` : ""}
  </form>
</section>
<section class="card">
  <form method="post" action="/quotes/${id}/status" class="stack">
    <label>Notes for the quote <textarea name="notes"${editable ? "" : " readonly"}>${q.notes ?? ""}</textarea></label>
    <div class="row">
      ${q.status === "draft" ? html`<button name="action" value="ready">Send for prices and approval</button>` : ""}
      ${isOwner && q.status === "ready" ? html`<button name="action" value="approve">Approve</button>
        <input name="review_note" placeholder="Note if sending back" aria-label="Note" style="max-width:20rem"><button name="action" value="return" class="secondary">Send back</button>` : ""}
      ${q.status === "approved" ? html`<label class="inline">Sent on <input type="date" name="sent_on" value="${todayUk()}"></label><button name="action" value="sent">Mark sent</button>` : ""}
      ${q.status === "sent" ? html`<button name="action" value="accepted">Accepted</button><button name="action" value="declined" class="secondary">Declined</button>` : ""}
      ${editable ? html`<button name="action" value="notes" class="secondary">Save notes</button>` : ""}
    </div>
  </form>
  ${q.status === "accepted" && q.client_status === "prospect" ? html`<form method="post" action="/clients/${q.client_id}/make-client" class="row" style="margin-top:.75rem">
    <label class="inline">Contract starts <input type="date" name="contract_start" value="${todayUk()}"></label>
    <button>Make ${q.client_name} a client</button></form>` : ""}
</section>`, "quotes");
  });

  r.post("/quotes/:id/lines", async (req, res) => {
    const id = idParam(req);
    const q = await one("select status from quotes where id = $1", [id]);
    if (!q) throw new NotFound();
    const isOwner = req.user!.role === "owner";
    if (!(q.status === "draft" || (isOwner && q.status === "ready"))) return res.redirect(`/quotes/${id}`);
    const lines = await query("select id from quote_lines where quote_id = $1", [id]);
    for (const l of lines) {
      const desc = s(req.body[`desc_${l.id}`]);
      if (desc) await query("update quote_lines set description = $2 where id = $1", [l.id, desc]);
      if (isOwner) {
        await query("update quote_lines set monthly_pence = $2, annual_pence = $3 where id = $1", [
          l.id, parseMoney(req.body[`monthly_${l.id}`]), parseMoney(req.body[`annual_${l.id}`]),
        ]);
      }
    }
    const remove = int(req.body.remove);
    if (remove) await query("delete from quote_lines where id = $1 and quote_id = $2", [remove, id]);
    const addItem = int(req.body.add_item);
    if (addItem) {
      const p = await one("select name, monthly_pence, annual_pence from price_items where id = $1", [addItem]);
      // Staff add the service; its list price is filled in for the owner to check.
      if (p) await query("insert into quote_lines (quote_id, description, monthly_pence, annual_pence, sort_order) values ($1,$2,$3,$4,$5)", [id, p.name, p.monthly_pence, p.annual_pence, lines.length]);
    }
    const custom = s(req.body.add_custom);
    if (custom) await query("insert into quote_lines (quote_id, description, sort_order) values ($1, $2, $3)", [id, custom, lines.length + 1]);
    await query("update quotes set updated_at = now() where id = $1", [id]);
    res.redirect(`/quotes/${id}`);
  });

  r.post("/quotes/:id/status", async (req, res) => {
    const id = idParam(req);
    const q = await one("select * from quotes where id = $1", [id]);
    if (!q) throw new NotFound();
    const isOwner = req.user!.role === "owner";
    const action = String(req.body.action ?? "");
    const editable = q.status === "draft" || (isOwner && q.status === "ready");
    if (editable && req.body.notes !== undefined) await query("update quotes set notes = $2 where id = $1", [id, s(req.body.notes)]);
    const set = (st: string, extra = "", params: unknown[] = []) =>
      query(`update quotes set status = '${st}'${extra}, updated_at = now() where id = $1`, [id, ...params]);
    const log = (body: string) => query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', $3)", [q.client_id, req.user!.id, body]);
    if (action === "ready" && q.status === "draft") await set("ready");
    else if (action === "approve" && isOwner && q.status === "ready") await set("approved", ", approved_by = $2, approved_at = now()", [req.user!.id]);
    else if (action === "return" && isOwner && q.status === "ready") await set("draft", ", review_note = $2", [s(req.body.review_note)]);
    else if (action === "sent" && q.status === "approved") {
      await set("sent", ", sent_on = $2", [dateOrNull(req.body.sent_on) ?? todayUk()]);
      await log(`Quote ${id} sent.`);
    } else if ((action === "accepted" || action === "declined") && q.status === "sent") {
      await set(action);
      await log(`Quote ${id} ${action}.`);
    }
    setFlash(req, "Saved.");
    res.redirect(`/quotes/${id}`);
  });

  return r;
}
