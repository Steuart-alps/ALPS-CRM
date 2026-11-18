// Runs the app against an empty test database. Needs TEST_DATABASE_URL
// (everything in that database is wiped).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : false;
if (url) process.env.DATABASE_URL = url;
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret-123";
process.env.BACKUP_TOKEN = "b".repeat(40);

let base = "";
let server: Server;
let db: typeof import("../src/db.ts");
let OTPAuth: typeof import("otpauth");
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

class Browser {
  cookie = "";
  async req(path: string, opts: { method?: string; form?: Record<string, string | string[]> } = {}) {
    const body = opts.form
      ? new URLSearchParams(Object.entries(opts.form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])))
      : undefined;
    const res = await fetch(base + path, {
      method: opts.method ?? (body ? "POST" : "GET"),
      redirect: "manual",
      headers: { cookie: this.cookie, origin: base, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
  }
  async signIn(email: string, password: string) {
    await this.req("/login", { form: { email, password } });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(SECRET) }).generate();
    const r = await this.req("/login/code", { form: { code } });
    assert.equal(r.location, "/");
  }
}

before(async () => {
  if (skip) return;
  db = await import("../src/db.ts");
  OTPAuth = await import("otpauth");
  await db.pool.query("drop schema public cascade; create schema public;");
  const { migrate } = await import("../src/migrate.ts");
  await migrate();
  const { createApp, seedTemplates } = await import("../src/app.ts");
  await seedTemplates();
  const { hashPassword } = await import("../src/auth.ts");
  const pw = await hashPassword("owner-password-long");
  await db.query(
    `insert into users (name, email, password_hash, role, totp_secret, totp_enabled) values
       ('Steuart Owner', 'owner@example.test', $1, 'owner', $2, true),
       ('Ayesha', 'pa@example.test', $1, 'staff', $2, true)`,
    [pw, SECRET],
  );
  await db.query("update users set office = true where email = 'pa@example.test'");
  await db.query("insert into assessors (name, email) values ('Elinor', 'elinor@example.test')");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  server?.close();
  await db.pool.end();
});

test("signed-out people are sent to sign in", { skip }, async () => {
  const b = new Browser();
  const r = await b.req("/clients");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/login");
});

test("forms from another website are refused", { skip }, async () => {
  const b = new Browser();
  await b.signIn("owner@example.test", "owner-password-long");
  const res = await fetch(base + "/clients", {
    method: "POST",
    headers: { cookie: b.cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "name=Evil",
    redirect: "manual",
  });
  assert.equal(res.status, 403);
});

test("prices are only shown to the owner, and staff saves keep them", { skip }, async () => {
  const owner = new Browser();
  await owner.signIn("owner@example.test", "owner-password-long");
  const created = await owner.req("/clients", {
    form: {
      name: "Lochside Hotel", status: "client", monthly: "150", annual: "", postcode: "iv2 6dh",
      visit_month: ["2", "8", "", ""], visit_days: ["2", "1", "1", "1"], visit_type: ["fire", "food", "", ""], visit_assessor: ["", "", "", ""],
      notice_months: "3",
    },
  });
  const id = created.location!.split("/").pop()!;
  const ownerView = await owner.req(`/clients/${id}`);
  assert.match(ownerView.text, /£150 a month/);

  const pa = new Browser();
  await pa.signIn("pa@example.test", "owner-password-long");
  const paView = await pa.req(`/clients/${id}`);
  assert.equal(paView.status, 200);
  assert.doesNotMatch(paView.text, /£/);
  const paEdit = await pa.req(`/clients/${id}/edit`);
  assert.doesNotMatch(paEdit.text, /name="monthly"/);
  await pa.req(`/clients/${id}`, {
    form: { name: "Lochside Hotel", status: "client", legal_name: "Lochside Ltd", visit_month: ["2", "8"], visit_days: ["2", "1"], visit_type: ["fire", "food"], visit_assessor: ["", ""], notice_months: "3" },
  });
  const row = await db.one("select monthly_pence, legal_name from clients where id = $1", [id]);
  assert.equal(row.monthly_pence, 15000);
  assert.equal(row.legal_name, "Lochside Ltd");

  assert.equal((await pa.req("/income")).status, 403);
  const csv = await pa.req("/export/mail-merge.csv");
  assert.doesNotMatch(csv.text.split("\n")[0], /Price/);
  assert.match(csv.text, /Lochside Hotel/);
  assert.equal((await pa.req("/export/backup.json")).status, 403);
  assert.equal((await owner.req("/export/backup.json")).status, 200);
  const tokenBackup = await fetch(base + "/export/backup.json", { headers: { authorization: `Bearer ${"b".repeat(40)}` } });
  assert.equal(tokenBackup.status, 200);
  const backup = await tokenBackup.json();
  assert.ok(!JSON.stringify(backup.users).includes("password"));
});

test("visits come from the plan, invites can be accepted, and asking to change makes a task", { skip }, async () => {
  const owner = new Browser();
  await owner.signIn("owner@example.test", "owner-password-long");
  const c = await db.one("select id from clients where name = 'Lochside Hotel'");
  await db.query("insert into contacts (client_id, name, email, is_primary) values ($1, 'Jo Bloggs', 'jo@example.test', true)", [c.id]);
  const elinor = await db.one("select id from assessors where name = 'Elinor'");
  await db.query("update clients set assessor_id = $2 where id = $1", [c.id, elinor.id]);
  const { syncClientVisits } = await import("../src/visits.ts");
  await syncClientVisits(c.id, [2030]);
  const visits = await db.query("select * from visits where client_id = $1 and year = 2030 order by seq", [c.id]);
  assert.deepEqual(visits.map((v) => [v.month, v.days, v.visit_type]), [[2, 2, "fire"], [8, 1, "food"]]);

  const v = visits[0];
  const booked = await owner.req(`/visits/${v.id}`, {
    form: { action: "book", assessor_id: String(elinor.id), booked_on: "2030-02-12", booked_time: "9:30", notes: "", send_invites: "1", confirm: "1" },
  });
  assert.equal(booked.status, 302);
  const after = await db.one("select * from visits where id = $1", [v.id]);
  assert.equal(after.status, "booked");
  assert.ok(after.client_token && after.assessor_token);
  const { sentMail } = await import("../src/email.ts");
  const invites = sentMail().filter((m) => m.subject.includes("Lochside"));
  assert.deepEqual(invites.map((m) => m.to).sort(), ["elinor@example.test", "jo@example.test"]);
  assert.match(invites[0].attachments![0].content, /BEGIN:VCALENDAR/);

  const anon = new Browser();
  const page1 = await anon.req(`/respond/${after.client_token}`);
  assert.match(page1.text, /Accept this visit/);
  await anon.req(`/respond/${after.assessor_token}`, { form: { answer: "accepted" } });
  await anon.req(`/respond/${after.client_token}`, { form: { answer: "change", note: "Any Wednesday" } });
  const answered = await db.one("select client_response, client_response_note, assessor_response from visits where id = $1", [v.id]);
  assert.deepEqual(answered, { client_response: "change", client_response_note: "Any Wednesday", assessor_response: "accepted" });
  const task = await db.one("select t.title, u.email from tasks t join users u on u.id = t.assigned_to where t.client_id = $1", [c.id]);
  assert.equal(task.email, "pa@example.test");
  assert.match(task.title, /Rebook February visit/);
  assert.equal((await anon.req("/respond/not-a-real-token-at-all-xyz")).status, 404);
});

test("document requests fill the master format with the client's details", { skip }, async () => {
  const pa = new Browser();
  await pa.signIn("pa@example.test", "owner-password-long");
  const c = await db.one("select id from clients where name = 'Lochside Hotel'");
  const r = await pa.req("/documents", { form: { client_id: String(c.id), kind: "ra", department: "Bar", title: "", template_id: "", assigned_to: "", due_on: "", notes: "" } });
  const id = r.location!.split("/").pop()!;
  const res = await fetch(`${base}/documents/${id}/create`, { headers: { cookie: pa.cookie } });
  assert.equal(res.status, 200);
  const PizZip = (await import("pizzip")).default;
  const xml = new PizZip(Buffer.from(await res.arrayBuffer())).file("word/document.xml")!.asText();
  assert.ok(xml.includes("Lochside Ltd t/a Lochside Hotel"));
  assert.ok(!xml.includes("Royal Ashdown"));
});

test("someone who does visits sets their own home postcode, and only their own", { skip }, async () => {
  const pa = new Browser();
  await pa.signIn("pa@example.test", "owner-password-long");
  const u = await db.one("select id from users where email = 'pa@example.test'");
  const mine = await db.one("insert into assessors (name, user_id) values ('Ayesha', $1) returning id", [u.id]);
  const elinor = await db.one("select id, home_postcode from assessors where name = 'Elinor'");
  assert.match((await pa.req("/me")).text, /Home postcode/);
  await pa.req("/me/home", { form: { assessor_id: String(mine.id), home_postcode: "ph1 1aa" } });
  await pa.req("/me/home", { form: { assessor_id: String(elinor.id), home_postcode: "IV2 6DH" } });
  assert.equal((await db.one("select home_postcode from assessors where id = $1", [mine.id])).home_postcode, "PH1 1AA");
  assert.equal((await db.one("select home_postcode from assessors where id = $1", [elinor.id])).home_postcode, elinor.home_postcode);
});

test("database completion shows progress and can be set as a task for the office", { skip }, async () => {
  const owner = new Browser();
  await owner.signIn("owner@example.test", "owner-password-long");
  const gaps = await owner.req("/gaps");
  assert.match(gaps.text, /Client database \d+% complete/);
  const pa = await db.one("select id from users where email = 'pa@example.test'");
  await owner.req("/gaps/task", { form: { assigned_to: String(pa.id), due_on: "" } });
  await owner.req("/gaps/task", { form: { assigned_to: String(pa.id), due_on: "" } });
  const tasks = await db.query("select assigned_to from tasks where title = 'Complete the client database' and status = 'open'");
  assert.deepEqual(tasks.map((t) => t.assigned_to), [pa.id]);
  assert.match((await owner.req("/gaps")).text, /Ayesha has this as a task/);
  const day = await db.one("select clients, possible from completion_daily order by day desc limit 1");
  assert.ok(day.clients >= 1 && day.possible > day.clients && day.possible % day.clients === 0);
});
