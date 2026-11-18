// Creates a client's copy of a Word template.
//
// Templates use ordinary Word mail-merge fields named like the columns of the
// old client spreadsheet (MERGEFIELD Company_Name, Address_1, Post_Code…), so
// the ALPS master formats work without changes. Each known field is replaced
// with the client's detail as plain text; unknown fields are left alone.
// "[Client / Site Name]" in the text is filled in too. Prices are never filled.
import PizZip from "pizzip";
import { one, query } from "./db.ts";
import { MONTHS, ukDate, todayUk, esc } from "./html.ts";

/** Merge fields a template can use, with what each one becomes. */
export const MERGE_FIELDS: [string, string][] = [
  ["Company_Name", "Legal name t/a trading name, e.g. Ness Castle Ltd t/a Ness Castle Lodges (just the trading name when there's no separate legal name)"],
  ["Legal_Name", "The client's legal name (trading name if not set)"],
  ["Trading_Name", "The client's trading name only"],
  ["Group", "Their group, if any"],
  ["Address_1", "Address line 1"],
  ["Address_2", "Address line 2"],
  ["Address_3", "Town"],
  ["Post_Code", "Postcode"],
  ["Telephone_Number", "Main phone number"],
  ["Type_of_Business", "Type of business"],
  ["Responsible_Person", "Main contact's full name"],
  ["First_Name", "Main contact's first name"],
  ["Title", "Main contact's job title"],
  ["Email_address", "Main contact's email"],
  ["Risk_Assessor", "Usual assessor"],
  ["Customer_Type", "What they call their public: Guest, Customer, Resident…"],
  ["Department", "The department the document is for, e.g. Bar"],
  ["Visit_Months", "Visit months, e.g. February (2 days), August"],
  ["Next_Visit", "The next booked visit's dates"],
  ["Today", "Today's date"],
];

const key = (name: string) => name.toLowerCase().replace(/[\s_]+/g, "");

export async function mergeData(clientId: number, department: string | null): Promise<Record<string, string>> {
  const c = await one(
    `select c.*, g.name as group_name, a.name as assessor_name from clients c
       left join client_groups g on g.id = c.group_id left join assessors a on a.id = c.assessor_id where c.id = $1`,
    [clientId],
  );
  if (!c) throw new Error("client not found");
  const k = await one("select * from contacts where client_id = $1 order by is_primary desc, id limit 1", [clientId]);
  const next = await one<{ booked_on: string; days: number }>(
    "select booked_on, days from visits where client_id = $1 and status = 'booked' and booked_on >= current_date order by booked_on limit 1",
    [clientId],
  );
  const data: Record<string, string> = {
    Company_Name: c.legal_name && c.legal_name.trim().toLowerCase() !== String(c.name).trim().toLowerCase()
      ? `${c.legal_name} t/a ${c.name}`
      : (c.name ?? ""),
    Legal_Name: c.legal_name ?? c.name ?? "",
    Trading_Name: c.name ?? "",
    Group: c.group_name ?? "",
    Address_1: c.address1 ?? "",
    Address_2: c.address2 ?? "",
    Address_3: c.town ?? "",
    Post_Code: c.postcode ?? "",
    Telephone_Number: c.phone ?? "",
    Type_of_Business: c.business_type ?? "",
    Responsible_Person: k?.name ?? "",
    First_Name: k?.first_name ?? k?.name?.split(" ")[0] ?? "",
    Title: k?.job_title ?? "",
    Email_address: k?.email ?? "",
    Risk_Assessor: c.assessor_name ?? "",
    Customer_Type: c.public_term ?? "",
    Department: department ?? "",
    Visit_Months: (c.visit_months as number[])
      .map((m, i) => `${MONTHS[m - 1]}${(c.visit_days[i] ?? 1) > 1 ? ` (${c.visit_days[i]} days)` : ""}`)
      .join(", "),
    Next_Visit: next ? `${ukDate(next.booked_on)}${next.days > 1 ? ` for ${next.days} days` : ""}` : "",
    Today: ukDate(todayUk()),
  };
  return Object.fromEntries(Object.entries(data).map(([k2, v]) => [key(k2), v]));
}

function textRun(rPr: string, value: string): string {
  const parts = value.split("\n").map((p) => `<w:t xml:space="preserve">${esc(p)}</w:t>`);
  return `<w:r>${rPr}${parts.join("<w:br/>")}</w:r>`;
}

const RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const rPrOf = (run: string) => /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";

/** Replaces known MERGEFIELDs in one XML part. Exported for tests. */
export function fillXml(xml: string, data: Record<string, string>, siteName: string): string {
  // Simple fields: <w:fldSimple w:instr=" MERGEFIELD Name "> ... </w:fldSimple>
  xml = xml.replace(/<w:fldSimple\b[^>]*w:instr="([^"]*)"[^>]*>([\s\S]*?)<\/w:fldSimple>/g, (whole, instr: string, inner: string) => {
    const m = /MERGEFIELD\s+"?([^\s"\\]+)/i.exec(instr);
    const value = m ? data[key(m[1])] : undefined;
    if (value === undefined) return whole;
    const firstRun = inner.match(RUN)?.[0] ?? "";
    return textRun(rPrOf(firstRun), value);
  });

  // Complex fields: begin run, instruction runs, separate run, result runs, end run.
  const runs = [...xml.matchAll(RUN)];
  const edits: { from: number; to: number; text: string }[] = [];
  let field: { start: number; instr: string; phase: "instr" | "result"; resultRun: string | null; depth: number } | null = null;
  for (const m of runs) {
    const run = m[0];
    const at = m.index!;
    const type = /w:fldCharType="(begin|separate|end)"/.exec(run)?.[1];
    if (type === "begin") {
      if (field) field.depth++;
      else field = { start: at, instr: "", phase: "instr", resultRun: null, depth: 0 };
      continue;
    }
    if (!field) continue;
    if (type === "separate" && field.depth === 0) {
      field.phase = "result";
      continue;
    }
    if (type === "end") {
      if (field.depth > 0) {
        field.depth--;
        continue;
      }
      const end = at + run.length;
      const name = /MERGEFIELD\s+"?([^\s"\\]+)/i.exec(field.instr)?.[1];
      const value = name ? data[key(name)] : undefined;
      const span = xml.slice(field.start, end);
      if (value !== undefined && !span.includes("</w:p>")) {
        edits.push({ from: field.start, to: end, text: textRun(rPrOf(field.resultRun ?? run), value) });
      }
      field = null;
      continue;
    }
    if (field.depth > 0) continue;
    if (field.phase === "instr") {
      field.instr += [...run.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)].map((x) => x[1]).join("");
    } else if (!field.resultRun && /<w:t[\s>]/.test(run)) {
      field.resultRun = run;
    }
  }
  for (const e of edits.reverse()) xml = xml.slice(0, e.from) + e.text + xml.slice(e.to);

  if (siteName) xml = xml.split("[Client / Site Name]").join(esc(siteName));
  return xml;
}

export function fillTemplate(template: Buffer, data: Record<string, string>): Buffer {
  const zip = new PizZip(template);
  const site = data[key("Company_Name")] ?? "";
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    const xml = zip.file(name)!.asText();
    zip.file(name, fillXml(xml, data, site));
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

/** Throws a readable message when the file isn't a Word document. */
export function checkTemplate(template: Buffer): void {
  try {
    const zip = new PizZip(template);
    if (!zip.file("word/document.xml")) throw new Error("no document");
  } catch {
    throw new Error("That file isn't a Word (.docx) document.");
  }
}

export async function templateList() {
  return query<{ id: number; name: string; filename: string; active: boolean; kind: string }>(
    "select id, name, filename, active, kind from doc_templates order by active desc, kind, name",
  );
}
