import { Router, type Request } from "express";
import { one, query, tx } from "../db.ts";
import { html, money, moneyInput, parseMoney, ukDate, todayUk, MONTHS, opt, checked, type SafeHtml } from "../html.ts";
import { s, int, dateOrNull, list, idParam, page, NotFound } from "../util.ts";
import { setFlash } from "../auth.ts";
import {
  assessors, groups, priceItems, activeUsers, officeUser, businessTypes,
  PUBLIC_TERMS, STATUS_LABEL, ACTIVITY_LABEL, VISIT_STATUS_LABEL,
} from "../lookups.ts";
import { syncClientVisits, reassignUnbooked, geocodeMissing } from "../visits.ts";
import { normalisePostcode } from "../geo.ts";

export type ClientRow = {
  id: number; group_id: number | null; name: string; legal_name: string | null; status: string; business_type: string | null;
  address1: string | null; address2: string | null; town: string | null; postcode: string | null;
  phone: string | null; website: string | null; assessor_id: number | null;
  contract_start: string | null; notice_months: number; first_year: number | null;
  monthly_pence: number | null; annual_pence: number | null; services: string[]; visit_months: number[];
  visit_days: number[]; visit_weekdays: number[]; visit_assessors: (number | null)[]; visit_types: string[];
  public_term: string | null; complytrack: boolean; notes: string | null;
};

/** Next date the annual contract rolls over, and the last day to give notice. */
export function contractDates(start: string | null, noticeMonths: number, today = todayUk()): { rollover: string; noticeBy: string } | null {
  if (!start) return null;
  const [y, m, d] = start.split("-").map(Number);
  let year = Number(today.slice(0, 4));
  const iso = (yy: number, mm: number, dd: number) => {
    const dt = new Date(Date.UTC(yy, mm - 1, 1));
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(dd, last)).padStart(2, "0")}`;
  };
  let rollover = iso(year, m, d);
  if (rollover <= today || year <= y) {
    year = Math.max(year, y + 1);
    rollover = iso(year, m, d);
    if (rollover <= today) rollover = iso(year + 1, m, d);
  }
  const [ry, rm, rd] = rollover.split("-").map(Number);
  const noticeBy = iso(ry, rm - noticeMonths, rd);
  return { rollover, noticeBy };
}

export function statusChip(status: string): SafeHtml {
  const cls = status === "client" ? "good" : status === "prospect" ? "warn" : "";
  return html`<span class="chip ${cls}">${STATUS_LABEL[status] ?? status}</span>`;
}

export const VISIT_TYPES: Record<string, string> = { general: "General H&S", fire: "Fire", food: "Food", compliance: "Compliance" };

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function monthsText(months: number[], days: number[] = []): string {
  return months.map((m, i) => MONTHS[m - 1]?.slice(0, 3) + ((days[i] ?? 1) > 1 ? ` (${days[i]}d)` : "")).join(", ");
}

export function weekdaysText(days: number[]): string {
  return days.length === 0 || days.length === 7 ? "Any day" : days.map((d) => WEEKDAYS[d - 1]).join(", ") + " only";
}

/** Filters shared by the client list and the mail-merge download. */
export function clientFilters(q: Request["query"]) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const status = typeof q.status === "string" ? q.status : "client";
  if (status !== "all") add("c.status = ?", status);
  const text = s(q.q);
  if (text) {
    add(`(c.name ilike ? or c.postcode ilike $${params.length + 1} or c.town ilike $${params.length + 1}
          or exists (select 1 from contacts k where k.client_id = c.id and (k.name ilike $${params.length + 1} or k.email ilike $${params.length + 1})))`, `%${text}%`);
  }
  const group = int(q.group);
  if (group) add("c.group_id = ?", group);
  const type = s(q.type);
  if (type) add("c.business_type = ?", type);
  const assessor = int(q.assessor);
  if (assessor) add("c.assessor_id = ?", assessor);
  const service = s(q.service);
  if (service) add("? = any(c.services)", service);
  const month = int(q.month);
  if (month) add("? = any(c.visit_months)", month);
  if (q.complytrack === "1") where.push("c.complytrack");
  return {
    sql: where.length ? "where " + where.join(" and ") : "",
    params,
    values: { status, q: text ?? "", group, type: type ?? "", assessor, service: service ?? "", month, complytrack: q.complytrack === "1" },
  };
}

async function clientForm(c: Partial<ClientRow>, action: string, title: string, isOwner: boolean): Promise<SafeHtml> {
  const [gs, as, ps, types] = await Promise.all([groups(), assessors(), priceItems(), businessTypes()]);
  const serviceNames = [...new Set([...ps.filter((p) => p.active).map((p) => p.name), ...(c.services ?? [])])];
  const vm = c.visit_months ?? [];
  const vd = c.visit_days ?? [];
  const va = c.visit_assessors ?? [];
  const vt = c.visit_types ?? [];
  const activeAssessors = as.filter((a) => a.active || va.includes(a.id) || a.id === c.assessor_id);
  const monthSelect = (i: number) => html`<div class="row">
      <label style="flex:2">${["1st", "2nd", "3rd", "4th"][i]} visit
        <select name="visit_month">
          <option value="">None</option>
          ${MONTHS.map((m, j) => opt(j + 1, m, vm[i]))}
        </select></label>
      <label style="flex:1.5">Type
        <select name="visit_type"><option value="">Not set</option>${Object.entries(VISIT_TYPES).map(([k, v]) => opt(k, v, vt[i]))}</select></label>
      <label style="flex:1">Days
        <select name="visit_days">${[1, 2, 3, 4, 5].map((d) => opt(d, String(d), vd[i] ?? 1))}</select></label>
      <label style="flex:2">Who does it
        <select name="visit_assessor"><option value="">Usual assessor</option>${activeAssessors.map((a) => opt(a.id, a.name, va[i]))}</select></label>
    </div>`;
  return html`<h1>${title}</h1>
<form method="post" action="${action}" class="stack card">
  <div class="fields">
    <label>Trading as <input name="name" value="${c.name ?? ""}" required></label>
    <label>Legal name <input name="legal_name" value="${c.legal_name ?? ""}" placeholder="e.g. Ness Castle Ltd"></label>
    <label>Status <select name="status">
      ${Object.entries(STATUS_LABEL).map(([k, v]) => opt(k, v, c.status ?? "client"))}
    </select></label>
    <label>Group <select name="group_id">
      <option value="">No group</option>
      ${gs.map((g) => opt(g.id, g.name, c.group_id))}
    </select></label>
    <label>Or a new group <input name="new_group" placeholder="e.g. Highland Coast Hotels Ltd"></label>
    <label>Type of business <input name="business_type" list="types" value="${c.business_type ?? ""}"></label>
    <datalist id="types">${types.map((t) => html`<option value="${t}">`)}</datalist>
    <label>Usual assessor <select name="assessor_id">
      <option value="">Not set</option>
      ${as.filter((a) => a.active || a.id === c.assessor_id).map((a) => opt(a.id, a.name, c.assessor_id))}
    </select></label>
  </div>
  <fieldset><legend>Address</legend><div class="fields">
    <label>Address line 1 <input name="address1" value="${c.address1 ?? ""}"></label>
    <label>Address line 2 <input name="address2" value="${c.address2 ?? ""}"></label>
    <label>Town <input name="town" value="${c.town ?? ""}"></label>
    <label>Postcode <input name="postcode" value="${c.postcode ?? ""}"></label>
    <label>Phone <input name="phone" value="${c.phone ?? ""}"></label>
    <label>Website <input name="website" value="${c.website ?? ""}"></label>
  </div></fieldset>
  <fieldset><legend>Contract</legend><div class="fields">
    <label>Contract start <input type="date" name="contract_start" value="${c.contract_start ?? ""}"></label>
    <label>Notice (months) <input type="number" min="0" max="12" name="notice_months" value="${c.notice_months ?? 3}"></label>
    <label>Client since (year) <input type="number" min="1990" max="2100" name="first_year" value="${c.first_year ?? ""}"></label>
    ${isOwner ? html`<label>Monthly price (£) <input name="monthly" inputmode="decimal" value="${moneyInput(c.monthly_pence)}"></label>
    <label>Annual price (£) <input name="annual" inputmode="decimal" value="${moneyInput(c.annual_pence)}"></label>` : ""}
    <label>Their public are called <select name="public_term">
      <option value="">Not set</option>
      ${PUBLIC_TERMS.map((t) => opt(t, t, c.public_term))}
    </select></label>
  </div>
  <p class="small muted">Services</p>
  <div class="checks">
    ${serviceNames.map((n) => html`<label class="inline"><input type="checkbox" name="services" value="${n}"${checked(c.services?.includes(n))}> ${n}</label>`)}
  </div>
  </fieldset>
  <fieldset><legend>Visits each year</legend>
    <div class="fields">${[0, 1, 2, 3].map(monthSelect)}</div>
    <p class="small muted">Days they accept visits</p>
    <div class="checks">${WEEKDAYS.map((d, i) => html`<label class="inline"><input type="checkbox" name="visit_weekdays" value="${i + 1}"${checked((c.visit_weekdays ?? []).includes(i + 1))}> ${d}</label>`)}</div>
    <p class="small muted">Leave every day unticked if any weekday is fine. The CRM adds each year's visits from these months, given to the usual assessor.</p>
  </fieldset>
  <label class="inline"><input type="checkbox" name="complytrack" value="1"${checked(c.complytrack)}> Uses ComplyTrack</label>
  <label>Notes <textarea name="notes">${c.notes ?? ""}</textarea></label>
  <div class="row"><button>Save</button><a href="${c.id ? `/clients/${c.id}` : "/clients"}">Cancel</a></div>
</form>`;
}

async function readClientForm(body: Record<string, unknown>) {
  let groupId = int(body.group_id);
  const newGroup = s(body.new_group);
  if (newGroup) {
    const g = await one<{ id: number }>(
      "insert into client_groups (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
      [newGroup],
    );
    groupId = g!.id;
  }
  const rawMonths = (Array.isArray(body.visit_month) ? body.visit_month : [body.visit_month]).map((m) => Number(m));
  const rawDays = (Array.isArray(body.visit_days) ? body.visit_days : [body.visit_days]).map((d) => Number(d));
  const rawWho = (Array.isArray(body.visit_assessor) ? body.visit_assessor : [body.visit_assessor]).map((a) => int(a));
  const rawType = (Array.isArray(body.visit_type) ? body.visit_type : [body.visit_type]).map((t) => String(t ?? ""));
  const types: string[] = [];
  const months: number[] = [];
  const days: number[] = [];
  const who: (number | null)[] = [];
  rawMonths.forEach((m, i) => {
    if (m >= 1 && m <= 12) {
      months.push(m);
      days.push(Math.min(5, Math.max(1, rawDays[i] || 1)));
      who.push(rawWho[i] ?? null);
      types.push(Object.keys(VISIT_TYPES).includes(rawType[i]) ? rawType[i] : "");
    }
  });
  const weekdays = list(body.visit_weekdays).map(Number).filter((d) => d >= 1 && d <= 7).sort();
  const status = ["prospect", "client", "former"].includes(String(body.status)) ? String(body.status) : "client";
  return {
    name: s(body.name) ?? "Unnamed",
    legal_name: s(body.legal_name),
    status,
    group_id: groupId,
    business_type: s(body.business_type),
    address1: s(body.address1), address2: s(body.address2), town: s(body.town),
    postcode: normalisePostcode(s(body.postcode)) ?? s(body.postcode),
    phone: s(body.phone), website: s(body.website),
    assessor_id: int(body.assessor_id),
    contract_start: dateOrNull(body.contract_start),
    notice_months: Math.min(12, Math.max(0, int(body.notice_months) ?? 3)),
    first_year: int(body.first_year),
    monthly_pence: parseMoney(body.monthly),
    annual_pence: parseMoney(body.annual),
    services: list(body.services),
    visit_months: months,
    visit_days: days,
    visit_assessors: who,
    visit_types: types,
    visit_weekdays: weekdays.length === 7 ? [] : weekdays,
    public_term: s(body.public_term),
    complytrack: body.complytrack === "1",
    notes: s(body.notes),
  };
}

const COLS = [
  "name", "legal_name", "status", "group_id", "business_type", "address1", "address2", "town", "postcode", "phone", "website",
  "assessor_id", "contract_start", "notice_months", "first_year", "monthly_pence", "annual_pence", "services",
  "visit_months", "visit_days", "visit_assessors", "visit_types", "visit_weekdays", "public_term", "complytrack", "notes",
] as const;
/** Only the owner sees or changes prices; staff saves leave them as they were. */
const MONEY_COLS = new Set<string>(["monthly_pence", "annual_pence"]);
const colsFor = (isOwner: boolean) => COLS.filter((k) => isOwner || !MONEY_COLS.has(k));

async function afterSave(id: number, before: ClientRow | undefined, after: Pick<ClientRow, "visit_assessors" | "assessor_id" | "visit_months">) {
  if (before) await reassignUnbooked(id, before, after);
  await syncClientVisits(id);
  // Postcode lookups need the internet; a failure only means no map position yet.
  geocodeMissing().catch((err) => console.error("postcode lookup failed", err.message));
}

export function clientsRouter(): Router {
  const r = Router();

  r.get("/clients", async (req, res) => {
    const f = clientFilters(req.query);
    const [rows, gs, as, ps, types] = await Promise.all([
      query(
        `select c.*, g.name as group_name, a.name as assessor_name,
                (select k.name from contacts k where k.client_id = c.id order by k.is_primary desc, k.id limit 1) as contact_name
           from clients c
           left join client_groups g on g.id = c.group_id
           left join assessors a on a.id = c.assessor_id
           ${f.sql}
          order by lower(c.name)`,
        f.params,
      ),
      groups(), assessors(), priceItems(), businessTypes(),
    ]);
    const qs = new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === "string") as [string, string][]).toString();
    const v = f.values;
    const isOwner = req.user!.role === "owner";
    page(req, res, "Clients", html`
<div class="spread"><h1>Clients <span class="muted small">(${rows.length})</span></h1>
  <div class="row">
    <a class="button secondary" href="/export/mail-merge.csv${qs ? "?" + qs : ""}">Download for mail merge</a>
    <a class="button secondary" href="/gaps">Missing details</a>
    <a class="button" href="/clients/new">Add client or prospect</a>
  </div>
</div>
<form method="get" class="filters card">
  <label>Search <input name="q" value="${v.q}" placeholder="Name, town, postcode, contact"></label>
  <label>Status <select name="status">
    ${opt("client", "Clients", v.status)}${opt("prospect", "Prospects", v.status)}${opt("former", "Former clients", v.status)}${opt("all", "Everyone", v.status)}
  </select></label>
  <label>Group <select name="group"><option value="">Any</option>${gs.map((g) => opt(g.id, g.name, v.group))}</select></label>
  <label>Type <select name="type"><option value="">Any</option>${types.map((t) => opt(t, t, v.type))}</select></label>
  <label>Assessor <select name="assessor"><option value="">Any</option>${as.map((a) => opt(a.id, a.name, v.assessor))}</select></label>
  <label>Service <select name="service"><option value="">Any</option>${ps.map((p) => opt(p.name, p.name, v.service))}</select></label>
  <label>Visit month <select name="month"><option value="">Any</option>${MONTHS.map((m, i) => opt(i + 1, m, v.month))}</select></label>
  <label class="inline"><input type="checkbox" name="complytrack" value="1"${checked(v.complytrack)}> Uses ComplyTrack</label>
  <div class="row"><button>Filter</button><a href="/clients">Clear</a></div>
</form>
<div class="table-wrap"><table>
  <thead><tr><th>Business</th><th>Group</th><th>Type</th><th>Town</th><th>Assessor</th><th>Visits</th>${isOwner ? html`<th>Monthly</th>` : ""}<th>Contact</th></tr></thead>
  <tbody>
  ${rows.map((c) => html`<tr>
    <td><a href="/clients/${c.id}">${c.name}</a> ${c.status !== "client" ? statusChip(c.status) : ""}</td>
    <td>${c.group_name ?? ""}</td>
    <td>${c.business_type ?? ""}</td>
    <td>${c.town ?? ""} <span class="muted small">${c.postcode ?? ""}</span></td>
    <td>${c.assessor_name ?? ""}</td>
    <td>${monthsText(c.visit_months, c.visit_days)}</td>
    ${isOwner ? html`<td>${money(c.monthly_pence)}</td>` : ""}
    <td>${c.contact_name ?? ""}</td>
  </tr>`)}
  ${rows.length === 0 ? html`<tr><td colspan="${isOwner ? 8 : 7}" class="muted">Nobody matches these filters.</td></tr>` : ""}
  </tbody>
</table></div>`, "clients");
  });

  r.get("/clients/new", async (req, res) => {
    const status = req.query.status === "prospect" ? "prospect" : "client";
    page(req, res, "Add client", await clientForm({ status, notice_months: 3 }, "/clients", "Add a client or prospect", req.user!.role === "owner"), "clients");
  });

  r.post("/clients", async (req, res) => {
    const v = await readClientForm(req.body);
    const cols = colsFor(req.user!.role === "owner");
    const row = await one<{ id: number }>(
      `insert into clients (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      cols.map((k) => v[k]),
    );
    await afterSave(row!.id, undefined, v);
    setFlash(req, `${v.name} added.`);
    res.redirect(`/clients/${row!.id}`);
  });

  r.get("/clients/:id/edit", async (req, res) => {
    const c = await one<ClientRow>("select * from clients where id = $1", [idParam(req)]);
    if (!c) throw new NotFound();
    page(req, res, `Edit ${c.name}`, await clientForm(c, `/clients/${c.id}`, `Edit ${c.name}`, req.user!.role === "owner"), "clients");
  });

  r.post("/clients/:id", async (req, res) => {
    const id = idParam(req);
    const old = await one<ClientRow>("select * from clients where id = $1", [id]);
    if (!old) throw new NotFound();
    const v = await readClientForm(req.body);
    const cols = colsFor(req.user!.role === "owner");
    await query(
      `update clients set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`,
      [id, ...cols.map((k) => v[k])],
    );
    await query(
      `update clients set left_on = case when status = 'former' then coalesce(left_on, current_date) else null end where id = $1`,
      [id],
    );
    await afterSave(id, old, v);
    setFlash(req, "Saved.");
    res.redirect(`/clients/${id}`);
  });

  // Prospect -> client. Prices and services come from the accepted quote when there is one.
  r.post("/clients/:id/make-client", async (req, res) => {
    const id = idParam(req);
    await tx(async (db) => {
      const q = (await db.query(
        "select id from quotes where client_id = $1 and status = 'accepted' order by updated_at desc limit 1",
        [id],
      )).rows[0];
      if (q) {
        const lines = (await db.query("select description, monthly_pence, annual_pence from quote_lines where quote_id = $1", [q.id])).rows;
        const monthly = lines.reduce((t, l) => t + (l.monthly_pence ?? 0), 0);
        const annual = lines.reduce((t, l) => t + (l.annual_pence ?? 0), 0);
        await db.query(
          `update clients set services = $2, monthly_pence = coalesce(nullif($3, 0), monthly_pence),
             annual_pence = coalesce(nullif($4, 0), annual_pence) where id = $1`,
          [id, lines.map((l) => l.description), monthly, annual],
        );
      }
      await db.query(
        `update clients set status = 'client', contract_start = coalesce(contract_start, $2::date),
           first_year = coalesce(first_year, extract(year from $2::date)::int), updated_at = now() where id = $1`,
        [id, dateOrNull(req.body.contract_start) ?? todayUk()],
      );
      await db.query(
        "insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', 'Became a client.')",
        [id, req.user!.id],
      );
    });
    await syncClientVisits(id);
    setFlash(req, "Now a client. Check the visit months and usual assessor so the visits get scheduled.");
    res.redirect(`/clients/${id}/edit`);
  });

  r.get("/clients/:id", async (req, res) => {
    const id = idParam(req);
    const c = await one<ClientRow & { group_name: string | null; assessor_name: string | null }>(
      `select c.*, g.name as group_name, a.name as assessor_name from clients c
         left join client_groups g on g.id = c.group_id left join assessors a on a.id = c.assessor_id where c.id = $1`,
      [id],
    );
    if (!c) throw new NotFound();
    const [contacts, visits, tasks, chasers, quotes, jobs, acts, users, as] = await Promise.all([
      query("select * from contacts where client_id = $1 order by is_primary desc, name", [id]),
      query(`select v.*, a.name as assessor_name from visits v left join assessors a on a.id = v.assessor_id
              where v.client_id = $1 and v.year >= $2 order by v.year, v.month, v.seq`, [id, Number(todayUk().slice(0, 4)) - 1]),
      query(`select t.*, u.name as assignee from tasks t left join users u on u.id = t.assigned_to
              where t.client_id = $1 order by t.status, t.due_on nulls last, t.id desc limit 30`, [id]),
      query("select * from chasers where client_id = $1 order by received_on nulls first, requested_on desc", [id]),
      query("select * from quotes where client_id = $1 order by created_at desc", [id]),
      query("select * from populate_jobs where client_id = $1 order by created_at desc", [id]),
      query(`select a.*, u.name as user_name from activities a left join users u on u.id = a.user_id
              where a.client_id = $1 order by a.happened_on desc, a.id desc limit 100`, [id]),
      activeUsers(),
      assessors(),
    ]);
    const cd = contractDates(c.contract_start, c.notice_months);
    const isOwner = req.user!.role === "owner";
    const today = todayUk();
    const nowKey = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
    page(req, res, c.name, html`
<div class="spread">
  <div><h1>${c.name} ${statusChip(c.status)}</h1>
    <div class="muted">${[c.legal_name && c.legal_name !== c.name ? c.legal_name : null, c.business_type, c.group_name].filter(Boolean).join(" · ")}</div></div>
  <div class="row">
    ${c.status === "prospect" ? html`<form method="post" action="/clients/${id}/make-client"><button>Make client</button></form>
      <a class="button secondary" href="/quotes/new?client=${id}">New quote</a>` : ""}
    <a class="button secondary" href="/clients/${id}/edit">Edit</a>
  </div>
</div>
<div class="grid">
  <section class="card">
    <h2>Details</h2>
    <p>${[c.address1, c.address2, c.town, c.postcode].filter(Boolean).join(", ") || html`<span class="muted">No address</span>`}</p>
    ${c.phone ? html`<p>Phone: <a href="tel:${c.phone}">${c.phone}</a></p>` : ""}
    ${c.website ? html`<p><a href="${/^https?:\/\//.test(c.website) ? c.website : "https://" + c.website}" rel="noopener" target="_blank">${c.website}</a></p>` : ""}
    <p>Usual assessor: <strong>${c.assessor_name ?? "not set"}</strong></p>
    ${c.status === "client" ? html`
      <p>Contract from ${c.contract_start ? ukDate(c.contract_start) : html`<span class="muted">not set</span>`}${c.first_year ? html`, client since ${c.first_year}` : ""}.
      ${cd ? html`<br><span class="small">Rolls over ${ukDate(cd.rollover)}; ${c.notice_months} months' notice means by ${ukDate(cd.noticeBy)}.</span>` : ""}</p>` : ""}
    ${isOwner ? html`<p>${c.monthly_pence !== null ? html`${money(c.monthly_pence)} a month` : ""}${c.annual_pence !== null ? html` · ${money(c.annual_pence)} a year` : ""}${c.monthly_pence !== null && c.annual_pence === null ? html` <span class="muted small">(${money(c.monthly_pence * 12)} a year)</span>` : ""}</p>` : ""}
    <p class="small">Visits: ${monthsText(c.visit_months, c.visit_days) || "none set"} · ${weekdaysText(c.visit_weekdays)}</p>
    <div>${c.services.map((sv) => html`<span class="chip">${sv}</span>`)}</div>
    ${c.public_term ? html`<p class="small muted">Their public: ${c.public_term}</p>` : ""}
    ${c.complytrack ? html`<p><span class="chip good">Uses ComplyTrack</span></p>` : ""}
    ${c.notes ? html`<p class="small">${c.notes}</p>` : ""}
  </section>

  <section class="card">
    <h2>Contacts</h2>
    <ul class="list">
    ${contacts.map((k) => html`<li>
      <strong>${k.name}</strong>${k.is_primary ? html` <span class="chip">Main</span>` : ""}${k.job_title ? html`<br><span class="small muted">${k.job_title}</span>` : ""}
      ${k.email ? html`<br><a href="mailto:${k.email}">${k.email}</a>` : ""}${k.phone ? html`<br><a href="tel:${k.phone}">${k.phone}</a>` : ""}
      <details class="small"><summary>Change</summary>
        <form method="post" action="/contacts/${k.id}" class="stack">
          <input name="name" value="${k.name}" required aria-label="Name">
          <input name="first_name" value="${k.first_name ?? ""}" placeholder="First name (for letters)" aria-label="First name">
          <input name="job_title" value="${k.job_title ?? ""}" placeholder="Job title" aria-label="Job title">
          <input name="email" type="email" value="${k.email ?? ""}" placeholder="Email" aria-label="Email">
          <input name="phone" value="${k.phone ?? ""}" placeholder="Phone" aria-label="Phone">
          <label class="inline"><input type="checkbox" name="is_primary" value="1"${checked(k.is_primary)}> Main contact</label>
          <div class="row"><button class="small">Save</button>
          <button class="small danger" formaction="/contacts/${k.id}/delete" data-confirm="Remove this contact?">Remove</button></div>
        </form>
      </details>
    </li>`)}
    ${contacts.length === 0 ? html`<li class="muted">No contacts yet.</li>` : ""}
    </ul>
    <details><summary>Add a contact</summary>
      <form method="post" action="/clients/${id}/contacts" class="stack">
        <input name="name" placeholder="Full name" required aria-label="Full name">
        <input name="first_name" placeholder="First name (for letters)" aria-label="First name">
        <input name="job_title" placeholder="Job title" aria-label="Job title">
        <input name="email" type="email" placeholder="Email" aria-label="Email">
        <input name="phone" placeholder="Phone" aria-label="Phone">
        <label class="inline"><input type="checkbox" name="is_primary" value="1"${checked(contacts.length === 0)}> Main contact</label>
        <button class="small">Add contact</button>
      </form>
    </details>
  </section>
</div>

${c.status === "client" || visits.length ? html`<section class="card">
  <div class="spread"><h2>Visits</h2><a href="/visits">Visit planner</a></div>
  <div class="table-wrap"><table>
    <thead><tr><th>Due</th><th>Assessor</th><th>Status</th><th></th></tr></thead>
    <tbody>${visits.map((v) => {
      const late = v.status === "to_book" && v.year * 12 + v.month < nowKey;
      return html`<tr>
      <td>${MONTHS[v.month - 1]} ${v.year} <span class="muted small">(visit ${v.seq}, ${v.days} day${v.days > 1 ? "s" : ""})</span>${v.visit_type ? html` <span class="chip">${VISIT_TYPES[v.visit_type]}</span>` : ""}</td>
      <td>${v.assessor_name ?? html`<span class="muted">Not set</span>`}</td>
      <td>${late ? html`<span class="overdue">Not booked, month passed</span>` : VISIT_STATUS_LABEL[v.status]}${v.booked_on ? html` · ${ukDate(v.booked_on)}${v.booked_time ? ` ${v.booked_time}` : ""}` : ""}${v.done_on ? html` · done ${ukDate(v.done_on)}` : ""}</td>
      <td><a href="/visits/${v.id}">Open</a></td></tr>`;
    })}
    ${visits.length === 0 ? html`<tr><td colspan="4" class="muted">No visits yet. Set visit months on Edit.</td></tr>` : ""}</tbody>
  </table></div>
</section>` : ""}

<div class="grid">
  <section class="card">
    <h2>Tasks</h2>
    <ul class="list">${tasks.map((t) => html`<li>
      ${t.status === "done" ? html`<s>${t.title}</s>` : html`<strong>${t.title}</strong>`}
      <span class="small muted"> · ${t.assignee ?? "nobody"}${t.due_on ? html` · due ${ukDate(t.due_on)}` : ""}</span>
      ${t.status === "open" && t.due_on && t.due_on < today ? html` <span class="overdue small">overdue</span>` : ""}
    </li>`)}
    ${tasks.length === 0 ? html`<li class="muted">No tasks.</li>` : ""}</ul>
    <details><summary>Set a task</summary>
      <form method="post" action="/tasks" class="stack">
        <input type="hidden" name="client_id" value="${id}">
        <input name="title" placeholder="What needs doing" required aria-label="Task">
        <textarea name="details" placeholder="Details (optional)" aria-label="Details"></textarea>
        <div class="fields">
          <label>For <select name="assigned_to">${users.map((u) => opt(u.id, u.name, officeUser(users)?.id ?? req.user!.id))}</select></label>
          <label>Due <input type="date" name="due_on"></label>
        </div>
        <button class="small">Set task</button>
      </form>
    </details>
  </section>

  <section class="card">
    <h2>Paperwork chasers</h2>
    <ul class="list">${chasers.map((ch) => html`<li>
      ${ch.received_on ? html`<s>${ch.item}</s> <span class="chip good">Received ${ukDate(ch.received_on)}</span>` : html`<strong>${ch.item}</strong>
        <span class="small muted"> · asked ${ukDate(ch.requested_on)}${ch.chase_again_on ? html` · chase again ${ukDate(ch.chase_again_on)}` : ""}</span>
        <form method="post" action="/chasers/${ch.id}/received" class="row small"><button class="small secondary">Mark received</button></form>`}
    </li>`)}
    ${chasers.length === 0 ? html`<li class="muted">Nothing being chased.</li>` : ""}</ul>
    <details><summary>Chase something</summary>
      <form method="post" action="/clients/${id}/chasers" class="stack">
        <input name="item" placeholder="e.g. Gas safety certificate" required aria-label="What is being chased">
        <div class="fields">
          <label>Asked on <input type="date" name="requested_on" value="${today}"></label>
          <label>Chase again on <input type="date" name="chase_again_on"></label>
        </div>
        <button class="small">Add</button>
      </form>
    </details>
  </section>
</div>

<div class="grid">
  <section class="card">
    <div class="spread"><h2>Quotes</h2><a href="/quotes/new?client=${id}">New quote</a></div>
    <ul class="list">${quotes.map((q) => html`<li><a href="/quotes/${q.id}">Quote ${q.id}</a> · ${q.status} · ${ukDate(q.created_at)}</li>`)}
    ${quotes.length === 0 ? html`<li class="muted">No quotes.</li>` : ""}</ul>
  </section>
  <section class="card">
    <div class="spread"><h2>ComplyTrack populate jobs</h2><a href="/populate/new?client=${id}">New job</a></div>
    <ul class="list">${jobs.map((j) => html`<li><a href="/populate/${j.id}">${j.title}</a> · ${j.status}</li>`)}
    ${jobs.length === 0 ? html`<li class="muted">None.</li>` : ""}</ul>
  </section>
</div>

<section class="card">
  <h2>Calls, emails and notes</h2>
  <form method="post" action="/clients/${id}/activities" class="stack">
    <div class="fields">
      <label>What <select name="kind">${Object.entries(ACTIVITY_LABEL).map(([k, v]) => opt(k, v, "call"))}</select></label>
      <label>When <input type="date" name="happened_on" value="${today}"></label>
    </div>
    <textarea name="body" placeholder="What was said or done" required aria-label="Notes"></textarea>
    <div><button class="small">Add to log</button></div>
  </form>
  <ul class="list">${acts.map((a) => html`<li>
    <span class="chip">${ACTIVITY_LABEL[a.kind]}</span> <span class="small muted">${ukDate(a.happened_on)} · ${a.user_name ?? ""}</span>
    <div style="white-space: pre-wrap">${a.body}</div></li>`)}</ul>
</section>`, "clients");
  });

  r.post("/clients/:id/contacts", async (req, res) => {
    const id = idParam(req);
    const primary = req.body.is_primary === "1";
    if (primary) await query("update contacts set is_primary = false where client_id = $1", [id]);
    await query(
      "insert into contacts (client_id, name, first_name, job_title, email, phone, is_primary) values ($1,$2,$3,$4,$5,$6,$7)",
      [id, s(req.body.name) ?? "Unnamed", s(req.body.first_name), s(req.body.job_title), s(req.body.email)?.toLowerCase() ?? null, s(req.body.phone), primary],
    );
    res.redirect(`/clients/${id}`);
  });

  r.post("/contacts/:id", async (req, res) => {
    const k = await one<{ client_id: number }>("select client_id from contacts where id = $1", [idParam(req)]);
    if (!k) throw new NotFound();
    const primary = req.body.is_primary === "1";
    if (primary) await query("update contacts set is_primary = false where client_id = $1", [k.client_id]);
    await query(
      "update contacts set name=$2, first_name=$3, job_title=$4, email=$5, phone=$6, is_primary=$7 where id=$1",
      [idParam(req), s(req.body.name) ?? "Unnamed", s(req.body.first_name), s(req.body.job_title), s(req.body.email)?.toLowerCase() ?? null, s(req.body.phone), primary],
    );
    res.redirect(`/clients/${k.client_id}`);
  });

  r.post("/contacts/:id/delete", async (req, res) => {
    const k = await one<{ client_id: number }>("delete from contacts where id = $1 returning client_id", [idParam(req)]);
    if (!k) throw new NotFound();
    setFlash(req, "Contact removed.");
    res.redirect(`/clients/${k.client_id}`);
  });

  r.post("/clients/:id/activities", async (req, res) => {
    const id = idParam(req);
    const kind = Object.keys(ACTIVITY_LABEL).includes(String(req.body.kind)) ? String(req.body.kind) : "note";
    const body = s(req.body.body);
    if (body) {
      await query(
        "insert into activities (client_id, user_id, kind, body, happened_on) values ($1, $2, $3, $4, $5)",
        [id, req.user!.id, kind, body, dateOrNull(req.body.happened_on) ?? todayUk()],
      );
    }
    res.redirect(`/clients/${id}`);
  });

  r.post("/clients/:id/chasers", async (req, res) => {
    const id = idParam(req);
    const item = s(req.body.item);
    if (item) {
      await query(
        "insert into chasers (client_id, item, requested_on, chase_again_on, created_by) values ($1, $2, $3, $4, $5)",
        [id, item, dateOrNull(req.body.requested_on) ?? todayUk(), dateOrNull(req.body.chase_again_on), req.user!.id],
      );
    }
    res.redirect(`/clients/${id}`);
  });

  return r;
}

