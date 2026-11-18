// "My details": anyone who does visits sets their own home postcode, which
// is where the visit planner starts their routes. Steuart, 18 Nov 2026:
// "Elinor sets her own". Only the postcode is kept, never a full address.
import { Router } from "express";
import { query } from "../db.ts";
import { html } from "../html.ts";
import { s, page } from "../util.ts";
import { setFlash } from "../auth.ts";
import { normalisePostcode } from "../geo.ts";
import { geocodeMissing } from "../visits.ts";

type Mine = { id: number; name: string; home_postcode: string | null; home_lat: number | null };

export function meRouter(): Router {
  const r = Router();

  r.get("/me", async (req, res) => {
    const mine = await query<Mine>("select id, name, home_postcode, home_lat from assessors where user_id = $1 order by name", [req.user!.id]);
    page(req, res, "My details", html`
<h1>My details</h1>
<section class="card">
  <h2>Home postcode</h2>
  ${mine.length === 0
    ? html`<p class="muted">You aren't set up to do visits. ${req.user!.role === "owner" ? html`Link your login to an assessor in <a href="/settings">Settings</a>.` : "Steuart can set that up in Settings if you need it."}</p>`
    : html`<p class="small muted">The visit planner starts your routes and drive times from here. Only the postcode is kept, and clients never see it.</p>
  ${mine.map((a) => html`<form method="post" action="/me/home" class="row">
    <input type="hidden" name="assessor_id" value="${a.id}">
    ${mine.length > 1 ? html`<strong>${a.name}</strong>` : ""}
    <input name="home_postcode" value="${a.home_postcode ?? ""}" placeholder="e.g. PH1 1AA" aria-label="Home postcode" style="max-width:12rem">
    <button>Save</button>
    ${a.home_postcode && a.home_lat === null ? html`<span class="small overdue">Postcode not placed on the map yet</span>` : ""}
  </form>`)}`}
</section>`);
  });

  r.post("/me/home", async (req, res) => {
    const raw = s(req.body.home_postcode);
    const pc = normalisePostcode(raw);
    if (raw && !pc) {
      setFlash(req, "That doesn't look like a UK postcode.");
      return res.redirect("/me");
    }
    // Only the assessor linked to this login can be changed here.
    const done = await query(
      `update assessors set
         home_lat = case when home_postcode is distinct from $3 then null else home_lat end,
         home_lng = case when home_postcode is distinct from $3 then null else home_lng end,
         home_postcode = $3
       where id = $1 and user_id = $2 returning id`,
      [Number(req.body.assessor_id), req.user!.id, pc],
    );
    if (done.length) await geocodeMissing().catch(() => {});
    setFlash(req, done.length ? "Home postcode saved." : "Nothing changed.");
    res.redirect("/me");
  });

  return r;
}
