import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { query, one } from "../db.ts";
import { MONTHS, ukDate, todayUk } from "../html.ts";
import { clientFilters } from "./clients.ts";

function csvCell(v: unknown): string {
  let t = v === null || v === undefined ? "" : String(v);
  // Stop spreadsheet apps treating a value as a formula.
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function tokenOk(req: Request): boolean {
  const expected = process.env.BACKUP_TOKEN ?? "";
  const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (expected.length < 32 || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The owner signed in, or the nightly backup job with BACKUP_TOKEN. */
function ownerOrToken(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === "owner" || tokenOk(req)) return next();
  res.status(req.user ? 403 : 401).send("Not allowed");
}

export function exportsRouter(): Router {
  const r = Router();

  // Same column names as the old mail-merge spreadsheet, so existing Word
  // merge documents keep working. Prices only go to the owner.
  r.get("/export/mail-merge.csv", async (req, res) => {
    if (!req.user) return res.redirect("/login");
    const isOwner = req.user.role === "owner";
    const f = clientFilters(req.query);
    const rows = await query(
      `select c.*, g.name as group_name, a.name as assessor_name, k.name as contact_name, k.first_name, k.job_title, k.email
         from clients c
         left join client_groups g on g.id = c.group_id
         left join assessors a on a.id = c.assessor_id
         left join lateral (select * from contacts k where k.client_id = c.id order by k.is_primary desc, k.id limit 1) k on true
         ${f.sql} order by lower(c.name)`,
      f.params,
    );
    const header = [
      "Group", "Company Name", "Legal Name", "Address 1", "Address 2", "Address 3", "Post Code", "Telephone Number",
      "Risk Assessor", "Date", "1st visit month", "2nd visit month", "3rd visit month", "4th visit month",
      "Type of Business", "Responsible Person", "First Name", "Title", "Email address", "Year", "Customer Type",
      ...(isOwner ? ["Monthly Price", "Annual Price"] : []),
      "Service 1", "Service 2", "Service 3", "Service 4", "Customer Type2",
    ];
    const body = rows.map((c) => [
      c.group_name, c.name, c.legal_name, c.address1, c.address2, c.town, c.postcode, c.phone,
      c.assessor_name, c.contract_start ? ukDate(c.contract_start) : "",
      ...[0, 1, 2, 3].map((i) => (c.visit_months[i] ? MONTHS[c.visit_months[i] - 1] : "")),
      c.business_type, c.contact_name, c.first_name, c.job_title, c.email, c.first_year, c.public_term,
      ...(isOwner ? [c.monthly_pence !== null ? c.monthly_pence / 100 : "", c.annual_pence !== null ? c.annual_pence / 100 : ""] : []),
      ...[0, 1, 2, 3].map((i) => c.services[i] ?? ""),
      c.status === "prospect" ? "Prospect" : c.status === "former" ? "Former client" : "Client",
    ]);
    res.set("content-type", "text/csv; charset=utf-8")
      .set("content-disposition", `attachment; filename="ALPS mail merge ${todayUk()}.csv"`)
      .send(toCsv(header, body));
  });

  r.get("/export/backup.json", ownerOrToken, async (_req, res) => {
    const tables = [
      "client_groups", "assessors", "clients", "contacts", "visits", "activities", "tasks", "chasers",
      "price_items", "quotes", "quote_lines", "populate_jobs", "populate_items", "doc_requests",
    ];
    const out: Record<string, unknown> = { exported_at: new Date().toISOString() };
    for (const t of tables) out[t] = await query(`select * from ${t} order by id`);
    // Sign-in secrets are never exported.
    out.users = await query("select id, name, email, role, active, created_at from users order by id");
    out.doc_files = (await query("select id, request_id, filename, mime, size, uploaded_by, created_at, encode(content, 'base64') as content_base64 from doc_files order by id"));
    out.doc_templates = await query("select id, name, filename, kind, active, created_at, encode(content, 'base64') as content_base64 from doc_templates order by id");
    const n = await one<{ n: number }>("select count(*)::int as n from clients");
    res.set("content-type", "application/json")
      .set("content-disposition", `attachment; filename="alps-crm-backup-${todayUk()}.json"`)
      .set("x-client-count", String(n?.n ?? 0))
      .send(JSON.stringify(out));
  });

  return r;
}
