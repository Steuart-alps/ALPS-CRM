// "Missing details": the gaps in client records for the office to fill in.
// Prices are deliberately not part of this list (they are the owner's).
import { Router } from "express";
import { query } from "../db.ts";
import { html } from "../html.ts";
import { page } from "../util.ts";

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

export async function gapCount(): Promise<number> {
  const rows = await query<{ n: number }>(
    `select count(*)::int as n from clients c where c.status = 'client' and (${GAP_CHECKS.map((g) => `(${g.sql})`).join(" or ")})`,
  );
  return rows[0]?.n ?? 0;
}

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
    page(req, res, "Missing details", html`
<h1>Missing details <span class="muted small">(${rows.length} clients)</span></h1>
<p class="small muted">Work through these to complete each client's record. Open a client, then Edit.</p>
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
  return r;
}
