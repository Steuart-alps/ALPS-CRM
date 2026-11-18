// Reads the old mail-merge spreadsheet (one row per business) into the CRM.
import ExcelJS from "exceljs";
import { tx } from "./db.ts";
import { MONTHS } from "./html.ts";
import { normalisePostcode } from "./geo.ts";

export type ImportResult = { added: number; skipped: string[]; problems: string[] };

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") return v.text.trim();
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((p) => p.text).join("").trim();
    if ("hyperlink" in v) return String((v as any).text ?? v.hyperlink).trim();
  }
  return String(v).trim();
}

const MONTH_INDEX = new Map(MONTHS.flatMap((m, i) => [[m.toLowerCase(), i + 1], [m.slice(0, 3).toLowerCase(), i + 1]] as [string, number][]));

export function parseMonth(s: string): number | null {
  return MONTH_INDEX.get(s.trim().toLowerCase()) ?? null;
}

/** "7th May 2021", "07/05/2021" or "2021-05-07" -> "2021-05-07". */
export function parseUkDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  let m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const mon = parseMonth(m[2]);
    if (mon) return `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function pence(s: string): number | null {
  const t = s.replace(/[£,\s]/g, "");
  if (!t || !Number.isFinite(Number(t))) return null;
  return Math.round(Number(t) * 100);
}

export async function importSpreadsheet(file: Buffer): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The spreadsheet has no sheets.");
  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    header[cellText(cell.value).toLowerCase().replace(/\s+/g, " ")] = col;
  });
  if (!header["company name"]) throw new Error('The first row needs a "Company Name" column.');
  const get = (row: ExcelJS.Row, name: string) => (header[name] ? cellText(row.getCell(header[name]).value) : "");

  const result: ImportResult = { added: 0, skipped: [], problems: [] };
  await tx(async (db) => {
    const existing = new Set((await db.query("select lower(trim(name)) as n from clients")).rows.map((r) => r.n));
    const groupId = async (name: string) => {
      if (!name) return null;
      const r = await db.query(
        "insert into client_groups (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
        [name],
      );
      return r.rows[0].id as number;
    };
    const assessorId = async (name: string) => {
      if (!name) return null;
      const r = await db.query(
        "insert into assessors (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
        [name],
      );
      return r.rows[0].id as number;
    };
    const known = (await db.query("select name from price_items")).rows.map((r) => r.name as string);

    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const name = get(row, "company name");
      if (!name) continue;
      if (existing.has(name.trim().toLowerCase())) {
        result.skipped.push(name);
        continue;
      }
      existing.add(name.trim().toLowerCase());
      const months: number[] = [];
      for (const col of ["1st visit month", "2nd visit month", "3nd visit month", "3rd visit month", "4th visit month"]) {
        const v = get(row, col);
        if (!v) continue;
        const m = parseMonth(v);
        if (m) months.push(m);
        else result.problems.push(`${name}: couldn't read visit month "${v}"`);
      }
      const services: string[] = [];
      for (const col of ["service 1", "service 2", "service 3", "service 4", "service 5"]) {
        const v = get(row, col);
        if (v && !services.includes(v)) services.push(v);
      }
      for (const sv of services) {
        if (!known.includes(sv)) {
          await db.query("insert into price_items (name, sort_order) values ($1, 100) on conflict (name) do nothing", [sv]);
          known.push(sv);
        }
      }
      // Steuart, 18 Nov 2026: the "Date" column is the contract start.
      const dateText = get(row, "date");
      const start = dateText ? parseUkDate(dateText) : null;
      if (dateText && !start) result.problems.push(`${name}: couldn't read the date "${dateText}"`);
      const year = Number(get(row, "year")) || (start ? Number(start.slice(0, 4)) : null);
      const monthly = pence(get(row, "monthly price"));
      const annual = pence(get(row, "annual price"));
      // Steuart, 18 Nov 2026: a client with a 0 or blank fee is no longer active.
      const paying = (monthly ?? 0) > 0 || (annual ?? 0) > 0;
      const status = /prospect/i.test(get(row, "customer type2")) ? "prospect" : paying ? "client" : "former";
      const publicTerm = get(row, "customer type") || null;
      const client = await db.query(
        `insert into clients (group_id, name, status, business_type, address1, address2, town, postcode, phone,
           assessor_id, contract_start, first_year, monthly_pence, annual_pence, services, visit_months, visit_days, public_term)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
        [
          await groupId(get(row, "group")),
          name.trim(),
          status,
          get(row, "type of business") || null,
          get(row, "address 1").replace(/,\s*$/, "") || null,
          get(row, "address 2").replace(/,\s*$/, "") || null,
          get(row, "address 3").replace(/,\s*$/, "") || null,
          normalisePostcode(get(row, "post code")) ?? (get(row, "post code") || null),
          get(row, "telephone number") || null,
          await assessorId(get(row, "risk assessor")),
          start,
          year,
          monthly,
          annual,
          services,
          months,
          months.map(() => 1),
          publicTerm,
        ],
      );
      const contact = get(row, "responsible person");
      const email = get(row, "email address").toLowerCase();
      if (contact || email) {
        await db.query(
          "insert into contacts (client_id, name, first_name, job_title, email, is_primary) values ($1, $2, $3, $4, $5, true)",
          [client.rows[0].id, contact || email, get(row, "first name") || null, get(row, "title") || null, email || null],
        );
      }
      result.added++;
    }
    // Link assessors to sign-in accounts with the same name, so invites reach them.
    await db.query(
      `update assessors a set user_id = u.id, email = coalesce(a.email, u.email)
         from users u where a.user_id is null and lower(trim(u.name)) = lower(trim(a.name))`,
    );
  });
  return result;
}
