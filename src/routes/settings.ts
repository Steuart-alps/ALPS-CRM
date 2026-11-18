import { Router } from "express";
import multer from "multer";
import { one, query } from "../db.ts";
import { html, moneyInput, parseMoney, opt, checked, ukDate } from "../html.ts";
import { s, idParam, page, NotFound, dateOrNull } from "../util.ts";
import { requireOwner, setFlash, hashPassword, MIN_PASSWORD } from "../auth.ts";
import { assessors, priceItems } from "../lookups.ts";
import { importSpreadsheet } from "../import.ts";
import { geocodeMissing, syncAllVisits } from "../visits.ts";
import { normalisePostcode } from "../geo.ts";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

export function settingsRouter(): Router {
  const r = Router();
  r.use("/settings", requireOwner);

  r.get("/settings", async (req, res) => {
    const [users, as, items, counts, away] = await Promise.all([
      query("select id, name, email, role, active, office, totp_enabled from users order by active desc, name"),
      assessors(),
      priceItems(),
      one("select (select count(*) from clients)::int as clients, (select count(*) from clients where postcode is not null and lat is null)::int as unplaced"),
      query("select * from assessor_away where to_date >= current_date order by from_date"),
    ]);
    page(req, res, "Settings", html`<h1>Settings</h1>
<div class="grid">
<section class="card">
  <h2>People who can sign in</h2>
  <ul class="list">${users.map((u) => html`<li>
    <strong>${u.name}</strong> <span class="chip">${u.role === "owner" ? "Owner (sees prices)" : "Staff"}</span>${u.office ? html` <span class="chip good">Office: books visits</span>` : ""}${u.active ? "" : html` <span class="chip bad">Switched off</span>`}
    <br><span class="small muted">${u.email}${u.totp_enabled ? " · sign-in code set up" : " · sign-in code not set up yet"}</span>
    <details class="small"><summary>Change</summary>
      <form method="post" action="/settings/users/${u.id}" class="stack">
        <input name="name" value="${u.name}" required aria-label="Name">
        <input name="email" type="email" value="${u.email}" required aria-label="Email">
        <select name="role" aria-label="Role">${opt("staff", "Staff", u.role)}${opt("owner", "Owner (sees prices)", u.role)}</select>
        <input name="password" type="password" minlength="${MIN_PASSWORD}" placeholder="New password (leave blank to keep)" autocomplete="new-password" aria-label="New password">
        <label class="inline"><input type="checkbox" name="reset_code" value="1"> Make them set up their sign-in code again (lost phone)</label>
        <label class="inline"><input type="checkbox" name="office" value="1"${checked(u.office)}> Office person: books visits, and new tasks and rebooking requests go to them</label>
        <label class="inline"><input type="checkbox" name="active" value="1"${checked(u.active)}> Can sign in</label>
        <button class="small">Save</button>
      </form>
    </details></li>`)}</ul>
  <details><summary>Add someone</summary>
    <form method="post" action="/settings/users" class="stack">
      <input name="name" placeholder="Name, e.g. Ayesha" required aria-label="Name">
      <input name="email" type="email" placeholder="Email" required aria-label="Email">
      <select name="role" aria-label="Role">${opt("staff", "Staff: no prices", "staff")}${opt("owner", "Owner: sees prices", "staff")}</select>
      <input name="password" type="password" minlength="${MIN_PASSWORD}" placeholder="Starting password (${MIN_PASSWORD}+ characters)" required autocomplete="new-password" aria-label="Starting password">
      <label class="inline"><input type="checkbox" name="office" value="1"> Office person: books visits, and new tasks and rebooking requests go to them</label>
      <label class="inline"><input type="checkbox" name="also_assessor" value="1"> Also does visits (adds them as an assessor)</label>
      <button class="small">Add</button>
    </form>
    <p class="small muted">Give them the password yourself. The first time they sign in they set up a code app on their phone.</p>
  </details>
</section>

<section class="card">
  <h2>Assessors</h2>
  <p class="small muted">The people who do visits. Their email gets the calendar invites; the home postcode is where the visit planner starts each route.</p>
  <ul class="list">${as.map((a) => html`<li>
    <form method="post" action="/settings/assessors/${a.id}" class="stack">
      <div class="row">
        <input name="name" value="${a.name}" required aria-label="Name" style="flex:2">
        <input name="email" type="email" value="${a.email ?? ""}" placeholder="Email for invites" aria-label="Email" style="flex:2">
        <input name="home_postcode" value="${a.home_postcode ?? ""}" placeholder="Home postcode" aria-label="Home postcode" style="flex:1">
      </div>
      <div class="row"><label class="inline small"><input type="checkbox" name="active" value="1"${checked(a.active)}> Active</label>
      <button class="small secondary">Save</button></div>
    </form>${a.home_postcode && a.home_lat === null ? html`<span class="small overdue">Postcode not placed on the map yet</span>` : ""}
    <details class="small"><summary>Away dates (${away.filter((w) => w.assessor_id === a.id).length})</summary>
      <ul class="list">${away.filter((w) => w.assessor_id === a.id).map((w) => html`<li class="row">${ukDate(w.from_date)}${w.to_date !== w.from_date ? html` to ${ukDate(w.to_date)}` : ""}${w.note ? ` · ${w.note}` : ""}
        <form method="post" action="/settings/away/${w.id}/delete"><button class="small secondary">Remove</button></form></li>`)}</ul>
      <form method="post" action="/settings/assessors/${a.id}/away" class="row">
        <input type="date" name="from_date" required aria-label="From"><input type="date" name="to_date" aria-label="To">
        <input name="note" placeholder="e.g. Holiday" aria-label="Note"><button class="small">Add</button>
      </form>
    </details></li>`)}</ul>
  <form method="post" action="/settings/assessors" class="row">
    <input name="name" placeholder="Add an assessor" required aria-label="Assessor name" style="flex:2">
    <input name="email" type="email" placeholder="Email" aria-label="Email" style="flex:2">
    <input name="home_postcode" placeholder="Home postcode" aria-label="Home postcode" style="flex:1">
    <button class="small">Add</button>
  </form>
</section>

<section class="card">
  <h2>Services and price list</h2>
  <p class="small muted">The services clients can take, and the list prices quotes start from. Only you see the prices.</p>
  <form method="post" action="/settings/prices" class="stack">
    <table><thead><tr><th>Service</th><th>Monthly £</th><th>Annual £</th><th>Use</th></tr></thead><tbody>
    ${items.map((p) => html`<tr>
      <td><input name="name_${p.id}" value="${p.name}" aria-label="Service"></td>
      <td><input name="monthly_${p.id}" value="${moneyInput(p.monthly_pence)}" inputmode="decimal" aria-label="Monthly"></td>
      <td><input name="annual_${p.id}" value="${moneyInput(p.annual_pence)}" inputmode="decimal" aria-label="Annual"></td>
      <td><input type="checkbox" name="active_${p.id}" value="1"${checked(p.active)} aria-label="In use"></td></tr>`)}
    <tr><td><input name="new_name" placeholder="New service" aria-label="New service"></td><td><input name="new_monthly" inputmode="decimal" aria-label="Monthly"></td><td><input name="new_annual" inputmode="decimal" aria-label="Annual"></td><td></td></tr>
    </tbody></table>
    <div><button class="small">Save price list</button></div>
  </form>
</section>

<section class="card">
  <h2>Bring in the client spreadsheet</h2>
  <p class="small">Upload the old mail-merge spreadsheet (.xlsx). Each row becomes a client with its contact, group, assessor, visit months, services and prices. Anyone already in the CRM with the same name is skipped, so it's safe to run twice. There are ${counts!.clients} clients in the CRM now.</p>
  <form method="post" action="/settings/import" enctype="multipart/form-data" class="stack">
    <input type="file" name="file" accept=".xlsx" required aria-label="Spreadsheet">
    <div><button class="small">Import</button></div>
  </form>
</section>

<section class="card">
  <h2>Map positions</h2>
  <p class="small">${counts!.unplaced} client postcode${counts!.unplaced === 1 ? "" : "s"} not placed yet. Postcodes are looked up with postcodes.io, a free UK service; only the postcode is sent.</p>
  <form method="post" action="/settings/geocode"><button class="small secondary">Look up postcodes now</button></form>
</section>

<section class="card">
  <h2>Backups</h2>
  <p class="small">Download everything in the CRM as one file. Your Mac can also fetch this each night (see the set-up notes).</p>
  <a class="button secondary small" href="/export/backup.json">Download a backup</a>
</section>
</div>`, "settings");
  });

  r.post("/settings/users", async (req, res) => {
    const name = s(req.body.name);
    const email = s(req.body.email)?.toLowerCase();
    const password = String(req.body.password ?? "");
    const role = req.body.role === "owner" ? "owner" : "staff";
    if (!name || !email || password.length < MIN_PASSWORD) {
      setFlash(req, `Fill in a name, email and a password of at least ${MIN_PASSWORD} characters.`);
      return res.redirect("/settings");
    }
    try {
      const u = await one<{ id: number }>("insert into users (name, email, password_hash, role, office) values ($1, $2, $3, $4, $5) returning id", [
        name, email, await hashPassword(password), role, req.body.office === "1",
      ]);
      if (req.body.also_assessor === "1") {
        await query("insert into assessors (name, user_id, email) values ($1, $2, $3) on conflict (name) do update set user_id = excluded.user_id, email = coalesce(assessors.email, excluded.email)", [name, u!.id, email]);
      }
      await query(
        `update assessors a set user_id = $1, email = coalesce(a.email, $3)
          where a.user_id is null and lower(trim(a.name)) = lower(trim($2))`,
        [u!.id, name, email],
      );
      setFlash(req, `${name} added.`);
    } catch {
      setFlash(req, "Someone already has that email.");
    }
    res.redirect("/settings");
  });

  r.post("/settings/users/:id", async (req, res) => {
    const id = idParam(req);
    const u = await one("select * from users where id = $1", [id]);
    if (!u) throw new NotFound();
    const role = req.body.role === "owner" ? "owner" : "staff";
    const active = req.body.active === "1";
    if (id === req.user!.id && (role !== "owner" || !active)) {
      setFlash(req, "You can't take away your own owner access.");
      return res.redirect("/settings");
    }
    const password = String(req.body.password ?? "");
    if (password && password.length < MIN_PASSWORD) {
      setFlash(req, `Passwords need at least ${MIN_PASSWORD} characters.`);
      return res.redirect("/settings");
    }
    try {
      await query("update users set name = $2, email = $3, role = $4, active = $5, office = $6 where id = $1", [
        id, s(req.body.name) ?? u.name, s(req.body.email)?.toLowerCase() ?? u.email, role, active, req.body.office === "1",
      ]);
    } catch {
      setFlash(req, "Someone else already has that email.");
      return res.redirect("/settings");
    }
    if (password) await query("update users set password_hash = $2 where id = $1", [id, await hashPassword(password)]);
    if (req.body.reset_code === "1") await query("update users set totp_secret = null, totp_enabled = false where id = $1", [id]);
    if (password || req.body.reset_code === "1" || !active) {
      // Sign them out everywhere so the change takes effect at once.
      await query(`delete from "session" where (sess->>'userId')::int = $1 or (sess->>'pendingUserId')::int = $1`, [id]);
    }
    setFlash(req, "Saved.");
    res.redirect("/settings");
  });

  r.post("/settings/assessors", async (req, res) => {
    const name = s(req.body.name);
    if (name) {
      await query("insert into assessors (name, home_postcode, email) values ($1, $2, $3) on conflict (name) do nothing", [name, normalisePostcode(s(req.body.home_postcode)), s(req.body.email)?.toLowerCase() ?? null]);
      geocodeMissing().catch(() => {});
    }
    res.redirect("/settings");
  });

  r.post("/settings/assessors/:id", async (req, res) => {
    const id = idParam(req);
    const pc = normalisePostcode(s(req.body.home_postcode));
    try {
      await query(
        `update assessors set name = $2, active = $3, email = $5,
           home_lat = case when home_postcode is distinct from $4 then null else home_lat end,
           home_lng = case when home_postcode is distinct from $4 then null else home_lng end,
           home_postcode = $4 where id = $1`,
        [id, s(req.body.name), req.body.active === "1", pc, s(req.body.email)?.toLowerCase() ?? null],
      );
    } catch {
      setFlash(req, "Another assessor already has that name.");
    }
    await geocodeMissing().catch(() => {});
    res.redirect("/settings");
  });

  r.post("/settings/assessors/:id/away", async (req, res) => {
    const from = dateOrNull(req.body.from_date);
    const to = dateOrNull(req.body.to_date) ?? from;
    if (from && to && to >= from) {
      await query("insert into assessor_away (assessor_id, from_date, to_date, note) values ($1, $2, $3, $4)", [idParam(req), from, to, s(req.body.note)]);
    } else setFlash(req, "Pick a start date, and an end date on or after it.");
    res.redirect("/settings");
  });

  r.post("/settings/away/:id/delete", async (req, res) => {
    await query("delete from assessor_away where id = $1", [idParam(req)]);
    res.redirect("/settings");
  });

  r.post("/settings/prices", async (req, res) => {
    const items = await priceItems();
    for (const p of items) {
      const name = s(req.body[`name_${p.id}`]) ?? p.name;
      try {
        await query("update price_items set name = $2, monthly_pence = $3, annual_pence = $4, active = $5 where id = $1", [
          p.id, name, parseMoney(req.body[`monthly_${p.id}`]), parseMoney(req.body[`annual_${p.id}`]), req.body[`active_${p.id}`] === "1",
        ]);
        if (name !== p.name) await query("update clients set services = array_replace(services, $1, $2)", [p.name, name]);
      } catch {
        setFlash(req, `Two services can't both be called "${name}".`);
      }
    }
    const newName = s(req.body.new_name);
    if (newName) {
      await query("insert into price_items (name, monthly_pence, annual_pence, sort_order) values ($1, $2, $3, 50) on conflict (name) do nothing", [
        newName, parseMoney(req.body.new_monthly), parseMoney(req.body.new_annual),
      ]);
    }
    setFlash(req, "Price list saved.");
    res.redirect("/settings");
  });

  r.post("/settings/import", upload.single("file"), async (req, res) => {
    if (!req.file) {
      setFlash(req, "Choose the spreadsheet first.");
      return res.redirect("/settings");
    }
    try {
      const result = await importSpreadsheet(req.file.buffer);
      await syncAllVisits();
      geocodeMissing().catch((err) => console.error("postcode lookup failed", err.message));
      const bits = [`${result.added} clients brought in`];
      if (result.skipped.length) bits.push(`${result.skipped.length} already here and skipped`);
      if (result.problems.length) bits.push(`check these: ${result.problems.slice(0, 10).join("; ")}`);
      setFlash(req, bits.join(". ") + ".");
    } catch (err: any) {
      setFlash(req, `Couldn't read that spreadsheet: ${err.message}`);
    }
    res.redirect("/settings");
  });

  r.post("/settings/geocode", async (req, res) => {
    try {
      const r2 = await geocodeMissing();
      setFlash(req, `Looked up ${r2.looked} postcodes and placed ${r2.found}.`);
    } catch (err: any) {
      setFlash(req, `The postcode service didn't answer (${err.message}). Try again later.`);
    }
    res.redirect("/settings");
  });

  return r;
}

