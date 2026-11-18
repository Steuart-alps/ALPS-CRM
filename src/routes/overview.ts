// The Today page, income (owner only) and groups.
import { Router } from "express";
import { one, query } from "../db.ts";
import { html, ukDate, todayUk, money, MONTHS, type SafeHtml } from "../html.ts";
import { s, idParam, page, NotFound } from "../util.ts";
import { requireOwner, setFlash } from "../auth.ts";
import { visitDates, dateRangeText } from "./visits.ts";
import { statusChip, monthsText } from "./clients.ts";
import { gapCount } from "./gaps.ts";

export function overviewRouter(): Router {
  const r = Router();

  r.get("/", async (req, res) => {
    const me = req.user!;
    const today = todayUk();
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const isOwner = me.role === "owner";
    const [tasks, docs, checking, quotes, visitCounts, missed, upcoming, chasers, gaps, waiting] = await Promise.all([
      query(`select t.*, c.name as client_name from tasks t left join clients c on c.id = t.client_id
              where t.assigned_to = $1 and t.status = 'open' order by t.due_on nulls last, t.id limit 20`, [me.id]),
      query(`select d.*, c.name as client_name from doc_requests d join clients c on c.id = d.client_id
              where d.assigned_to = $1 and d.status in ('requested', 'returned') order by d.due_on nulls last limit 20`, [me.id]),
      isOwner ? query(`select d.id, d.title, c.name as client_name from doc_requests d join clients c on c.id = d.client_id where d.status = 'ready' order by d.updated_at`) : Promise.resolve([]),
      isOwner ? query(`select q.id, c.name as client_name from quotes q join clients c on c.id = q.client_id where q.status = 'ready' order by q.updated_at`) : Promise.resolve([]),
      query<{ status: string; n: number }>("select status, count(*)::int as n from visits where year = $1 and month = $2 group by status", [y, m]),
      one<{ n: number }>("select count(*)::int as n from visits where status = 'to_book' and year * 12 + month < $1", [y * 12 + m]),
      query(`select v.*, c.name as client_name, c.visit_weekdays, a.name as assessor_name from visits v join clients c on c.id = v.client_id
              left join assessors a on a.id = v.assessor_id
              where v.status = 'booked' and v.booked_on between $1::date and $1::date + 14 order by v.booked_on`, [today]),
      query(`select ch.*, c.name as client_name from chasers ch join clients c on c.id = ch.client_id
              where ch.received_on is null and ch.chase_again_on <= $1 order by ch.chase_again_on limit 20`, [today]),
      gapCount(),
      query(`select v.id, c.name as client_name, v.booked_on, v.client_response, v.assessor_response from visits v join clients c on c.id = v.client_id
              where v.status = 'booked' and v.invited_at is not null and v.booked_on >= $1::date
                and (v.client_response = 'change' or v.assessor_response = 'change'
                     or ((v.client_response is null or v.assessor_response is null) and v.invited_at < now() - interval '3 days'))
              order by v.booked_on limit 20`, [today]),
    ]);
    const count = (st: string) => visitCounts.find((v) => v.status === st)?.n ?? 0;
    const due = (d: string | null) => (d ? html` · <span class="${d < today ? "overdue" : ""}">due ${ukDate(d)}</span>` : "");
    page(req, res, "Today", html`
<h1>Hello ${me.name.split(" ")[0]}</h1>
<div class="grid">
  <a class="card" href="/visits" style="text-decoration:none;color:inherit">
    <div class="muted small">${MONTHS[m - 1]} visits</div>
    <div class="stat">${count("to_book")} to book</div>
    <div class="small">${count("booked")} booked · ${count("done")} done${missed && missed.n ? html` · <span class="overdue">${missed.n} from earlier months not booked</span>` : ""}</div>
  </a>
  <a class="card" href="/tasks" style="text-decoration:none;color:inherit">
    <div class="muted small">My tasks</div><div class="stat">${tasks.length}</div>
    <div class="small">${tasks.filter((t) => t.due_on && t.due_on < today).length} overdue</div>
  </a>
  <a class="card" href="/documents?view=mine" style="text-decoration:none;color:inherit">
    <div class="muted small">Documents for me to create</div><div class="stat">${docs.length}</div>
  </a>
  <a class="card" href="/gaps" style="text-decoration:none;color:inherit">
    <div class="muted small">Clients with missing details</div><div class="stat">${gaps}</div>
  </a>
  ${isOwner ? html`<a class="card" href="/documents?view=checking" style="text-decoration:none;color:inherit">
    <div class="muted small">Waiting for you to check</div><div class="stat">${checking.length + quotes.length}</div>
    <div class="small">${checking.length} document${checking.length === 1 ? "" : "s"} · ${quotes.length} quote${quotes.length === 1 ? "" : "s"}</div></a>` : ""}
</div>
<div class="grid" style="margin-top:1rem">
  <section class="card"><h2>My tasks</h2>
    <ul class="list">${tasks.map((t) => html`<li><strong>${t.title}</strong>${t.client_name ? html` · <a href="/clients/${t.client_id}">${t.client_name}</a>` : ""}<span class="small">${due(t.due_on)}</span></li>`)}
    ${tasks.length === 0 ? html`<li class="muted">All clear.</li>` : ""}</ul></section>
  <section class="card"><h2>Documents to create</h2>
    <ul class="list">${docs.map((d) => html`<li><a href="/documents/${d.id}">${d.title}</a> · ${d.client_name}${d.status === "returned" ? html` <span class="chip bad">Sent back</span>` : ""}<span class="small">${due(d.due_on)}</span></li>`)}
    ${docs.length === 0 ? html`<li class="muted">None.</li>` : ""}</ul></section>
  ${isOwner ? html`<section class="card"><h2>For you to check</h2>
    <ul class="list">${checking.map((d) => html`<li><a href="/documents/${d.id}">${d.title}</a> · ${d.client_name}</li>`)}
    ${quotes.map((q) => html`<li><a href="/quotes/${q.id}">Quote ${q.id}</a> · ${q.client_name} <span class="chip warn">needs prices</span></li>`)}
    ${checking.length + quotes.length === 0 ? html`<li class="muted">Nothing waiting.</li>` : ""}</ul></section>` : ""}
  <section class="card"><h2>Booked visits, next 2 weeks</h2>
    <ul class="list">${upcoming.map((v) => html`<li><a href="/visits/${v.id}">${v.client_name}</a><br><span class="small">${dateRangeText(visitDates(v.booked_on, v.days, v.visit_weekdays))}${v.booked_time ? ` · ${v.booked_time}` : ""} · ${v.assessor_name ?? "no assessor"}</span></li>`)}
    ${upcoming.length === 0 ? html`<li class="muted">None booked.</li>` : ""}</ul></section>
  <section class="card"><h2>Invites to chase</h2>
    <p class="small muted">Asked for another date, or not answered after 3 days.</p>
    <ul class="list">${waiting.map((v) => html`<li><a href="/visits/${v.id}">${v.client_name}</a> · ${ukDate(v.booked_on)}
      ${v.client_response === "change" || v.assessor_response === "change" ? html` <span class="chip bad">Wants another date</span>` : html` <span class="chip warn">No answer</span>`}</li>`)}
    ${waiting.length === 0 ? html`<li class="muted">Nothing to chase.</li>` : ""}</ul></section>
  <section class="card"><h2>Chase today</h2>
    <ul class="list">${chasers.map((ch) => html`<li>${ch.item} · <a href="/clients/${ch.client_id}">${ch.client_name}</a></li>`)}
    ${chasers.length === 0 ? html`<li class="muted">Nothing to chase today.</li>` : ""}</ul></section>
</div>`, "home");
  });

  r.get("/income", requireOwner, async (req, res) => {
    const today = todayUk();
    const year = Number(today.slice(0, 4));
    const yearly = "coalesce(c.annual_pence, c.monthly_pence * 12, 0)";
    const [tot, byAssessor, byType, byGroup, byService, newOnes, leavers, noPrice, pipeline] = await Promise.all([
      one(`select count(*)::int as n, coalesce(sum(coalesce(c.monthly_pence, c.annual_pence / 12)), 0)::bigint as monthly, coalesce(sum(${yearly}), 0)::bigint as yearly,
              coalesce(sum(${yearly}) filter (where c.complytrack), 0)::bigint as ct_yearly, count(*) filter (where c.complytrack)::int as ct_n
             from clients c where c.status = 'client'`),
      query(`select coalesce(a.name, 'Not set') as label, count(*)::int as n, coalesce(sum(${yearly}), 0)::bigint as yearly
               from clients c left join assessors a on a.id = c.assessor_id where c.status = 'client' group by 1 order by 3 desc`),
      query(`select coalesce(c.business_type, 'Not set') as label, count(*)::int as n, coalesce(sum(${yearly}), 0)::bigint as yearly
               from clients c where c.status = 'client' group by 1 order by 3 desc`),
      query(`select coalesce(g.name, 'No group') as label, count(*)::int as n, coalesce(sum(${yearly}), 0)::bigint as yearly
               from clients c left join client_groups g on g.id = c.group_id where c.status = 'client' group by 1 order by 3 desc`),
      query(`select sv as label, count(*)::int as n, coalesce(sum(${yearly}), 0)::bigint as yearly
               from clients c, unnest(c.services) sv where c.status = 'client' group by 1 order by 2 desc`),
      query(`select c.id, c.name, ${yearly}::bigint as yearly, c.contract_start, c.first_year from clients c
              where c.status = 'client' and (extract(year from c.contract_start) = $1 or (c.contract_start is null and c.first_year = $1))
              order by c.contract_start nulls last`, [year]),
      query(`select c.id, c.name, ${yearly}::bigint as yearly, c.left_on from clients c where c.status = 'former' and extract(year from c.left_on) = $1 order by c.left_on`, [year]),
      query(`select c.id, c.name from clients c where c.status = 'client' and c.monthly_pence is null and c.annual_pence is null order by c.name`),
      query(`select q.status, count(*)::int as n,
                    coalesce(sum((select coalesce(sum(coalesce(l.annual_pence, l.monthly_pence * 12, 0)), 0) from quote_lines l where l.quote_id = q.id)), 0)::bigint as yearly
               from quotes q where q.status in ('draft', 'ready', 'approved', 'sent') group by q.status`),
    ]);
    const n = (v: unknown) => Number(v ?? 0);
    const table = (title: string, rows: any[], hint?: string): SafeHtml => {
      const max = Math.max(1, ...rows.map((r) => n(r.yearly)));
      return html`<section class="card"><h2>${title}</h2>${hint ? html`<p class="small muted">${hint}</p>` : ""}
      <table><tbody>${rows.map((r) => html`<tr><td>${r.label}<div style="height:6px;background:#1f5c99;border-radius:3px;width:${Math.round((n(r.yearly) / max) * 100)}%"></div></td>
        <td class="small muted">${r.n} client${r.n === 1 ? "" : "s"}</td><td style="text-align:right">${money(n(r.yearly))}</td></tr>`)}</tbody></table></section>`;
    };
    const newTotal = newOnes.reduce((t, c) => t + n(c.yearly), 0);
    const lostTotal = leavers.reduce((t, c) => t + n(c.yearly), 0);
    const pipeTotal = pipeline.reduce((t, p) => t + n(p.yearly), 0);
    page(req, res, "Income", html`
<h1>Income</h1>
<p class="small muted">Only you can see this page. Yearly figures use the annual price, or 12 × the monthly price where there&apos;s no annual price; monthly figures use the monthly price, or the annual price ÷ 12.</p>
<div class="grid">
  <div class="card"><div class="muted small">Coming in each month</div><div class="stat">${money(n(tot!.monthly))}</div><div class="small">${tot!.n} clients</div></div>
  <div class="card"><div class="muted small">A year</div><div class="stat">${money(n(tot!.yearly))}</div><div class="small">${money(n(tot!.ct_yearly))} from ${tot!.ct_n} who also use ComplyTrack</div></div>
  <div class="card"><div class="muted small">Won and lost in ${year}</div><div class="stat">+${money(newTotal)}</div><div class="small">${newOnes.length} new · <span class="overdue">−${money(lostTotal)}</span> from ${leavers.length} leaving</div></div>
  <div class="card"><div class="muted small">Quotes still open</div><div class="stat">${money(pipeTotal)}</div><div class="small">a year, if all are accepted</div></div>
</div>
<div class="grid" style="margin-top:1rem">
  ${table("By assessor", byAssessor)}
  ${table("By type of business", byType)}
  ${table("By group", byGroup)}
  ${table("By service", byService, "Clients taking each service and what those clients pay in total (a client with several services counts under each).")}
</div>
<div class="grid" style="margin-top:1rem">
  <section class="card"><h2>New in ${year}</h2><ul class="list">${newOnes.map((c) => html`<li><a href="/clients/${c.id}">${c.name}</a> · ${money(n(c.yearly))} a year${c.contract_start ? html` <span class="small muted">from ${ukDate(c.contract_start)}</span>` : ""}</li>`)}
    ${newOnes.length === 0 ? html`<li class="muted">None yet.</li>` : ""}</ul></section>
  <section class="card"><h2>Left in ${year}</h2><ul class="list">${leavers.map((c) => html`<li><a href="/clients/${c.id}">${c.name}</a> · ${money(n(c.yearly))} a year <span class="small muted">${ukDate(c.left_on)}</span></li>`)}
    ${leavers.length === 0 ? html`<li class="muted">Nobody.</li>` : ""}</ul></section>
  <section class="card"><h2>Clients with no price</h2><ul class="list">${noPrice.map((c) => html`<li><a href="/clients/${c.id}/edit">${c.name}</a></li>`)}
    ${noPrice.length === 0 ? html`<li class="muted">Every client has a price.</li>` : ""}</ul></section>
</div>`, "income");
  });

  r.get("/groups", async (req, res) => {
    const isOwner = req.user!.role === "owner";
    const rows = await query(
      `select g.*, count(c.id) filter (where c.status = 'client')::int as clients, count(c.id) filter (where c.status = 'prospect')::int as prospects,
              coalesce(sum(coalesce(c.annual_pence, c.monthly_pence * 12, 0)) filter (where c.status = 'client'), 0)::bigint as yearly
         from client_groups g left join clients c on c.group_id = g.id group by g.id order by g.name`,
    );
    page(req, res, "Groups", html`<h1>Groups</h1>
<div class="table-wrap"><table><thead><tr><th>Group</th><th>Clients</th><th>Prospects</th>${isOwner ? html`<th>A year</th>` : ""}</tr></thead>
<tbody>${rows.map((g) => html`<tr><td><a href="/groups/${g.id}">${g.name}</a></td><td>${g.clients}</td><td>${g.prospects}</td>${isOwner ? html`<td>${money(Number(g.yearly))}</td>` : ""}</tr>`)}
${rows.length === 0 ? html`<tr><td colspan="4" class="muted">No groups yet. Pick or add one when editing a client.</td></tr>` : ""}</tbody></table></div>`, "groups");
  });

  r.get("/groups/:id", async (req, res) => {
    const id = idParam(req);
    const g = await one("select * from client_groups where id = $1", [id]);
    if (!g) throw new NotFound();
    const clients = await query("select * from clients where group_id = $1 order by status, lower(name)", [id]);
    page(req, res, g.name, html`<h1>${g.name}</h1>
<form method="post" action="/groups/${id}" class="stack card">
  <label>Group name <input name="name" value="${g.name}" required></label>
  <label>Notes <textarea name="notes">${g.notes ?? ""}</textarea></label>
  <div><button class="secondary">Save</button></div>
</form>
<ul class="list card">${clients.map((c) => html`<li><a href="/clients/${c.id}">${c.name}</a> ${statusChip(c.status)} <span class="small muted">${c.town ?? ""} · ${monthsText(c.visit_months, c.visit_days)}</span></li>`)}</ul>`, "groups");
  });

  r.post("/groups/:id", async (req, res) => {
    const id = idParam(req);
    const name = s(req.body.name);
    if (name) {
      try {
        await query("update client_groups set name = $2, notes = $3 where id = $1", [id, name, s(req.body.notes)]);
        setFlash(req, "Saved.");
      } catch {
        setFlash(req, "Another group already has that name.");
      }
    }
    res.redirect(`/groups/${id}`);
  });

  return r;
}
