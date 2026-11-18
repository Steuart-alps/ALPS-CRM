import { query } from "./db.ts";
import { lookupPostcodes, normalisePostcode } from "./geo.ts";
import { todayUk } from "./html.ts";

/**
 * Creates the year's visits for a client from its visit months: the 1st
 * visit month is visit 1, and so on. Visits not booked yet follow later
 * changes to the months or the usual assessor; booked and done ones are left
 * alone. Months before the contract start are skipped.
 */
export async function syncClientVisits(clientId: number, years?: number[]): Promise<void> {
  const [c] = await query<{
    status: string;
    visit_months: number[];
    visit_days: number[];
    visit_assessors: (number | null)[];
    visit_types: string[];
    assessor_id: number | null;
    contract_start: string | null;
  }>("select status, visit_months, visit_days, visit_assessors, visit_types, assessor_id, contract_start from clients where id = $1", [clientId]);
  if (!c) return;
  const thisYear = Number(todayUk().slice(0, 4));
  const ys = years ?? [thisYear, thisYear + 1];
  const today = todayUk();
  const nowKey = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));

  if (c.status !== "client") {
    // A former client or a prospect has no visits to book from now on.
    await query(
      "delete from visits where client_id = $1 and status = 'to_book' and year * 12 + month >= $2",
      [clientId, nowKey],
    );
    return;
  }

  const startKey = c.contract_start
    ? Number(c.contract_start.slice(0, 4)) * 12 + Number(c.contract_start.slice(5, 7))
    : 0;

  for (const year of ys) {
    const wanted = c.visit_months
      .map((month, i) => ({
        seq: i + 1,
        month,
        days: Math.min(5, Math.max(1, c.visit_days[i] ?? 1)),
        assessor: c.visit_assessors[i] ?? c.assessor_id,
        type: c.visit_types[i] || null,
      }))
      .filter((v) => year * 12 + v.month >= startKey);
    for (const v of wanted) {
      // Months already gone are not created after the fact (e.g. on first import);
      // visits that already exist for them stay, so missed visits still show.
      if (year * 12 + v.month < nowKey) {
        await query(
          `update visits set month = $4, days = $5, visit_type = $6, updated_at = now()
            where client_id = $1 and year = $2 and seq = $3 and status = 'to_book'`,
          [clientId, year, v.seq, v.month, v.days, v.type],
        );
        continue;
      }
      await query(
        `insert into visits (client_id, year, month, seq, days, assessor_id, visit_type)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (client_id, year, seq) do update
           set month = excluded.month, days = excluded.days, visit_type = excluded.visit_type, updated_at = now()
           where visits.status = 'to_book'
             and (visits.month, visits.days, coalesce(visits.visit_type, '')) <> (excluded.month, excluded.days, coalesce(excluded.visit_type, ''))`,
        [clientId, year, v.month, v.seq, v.days, v.assessor, v.type],
      );
    }
    // Unbooked visits for months the client no longer has.
    await query(
      `delete from visits where client_id = $1 and year = $2 and status = 'to_book'
         and not (seq = any($3::int[]))`,
      [clientId, year, wanted.map((v) => v.seq)],
    );
  }
}

/** Who does visit N by plan: its own pick, else the usual assessor. */
export function planAssessor(c: { visit_assessors: (number | null)[]; assessor_id: number | null }, seq: number): number | null {
  return c.visit_assessors[seq - 1] ?? c.assessor_id;
}

/**
 * When the plan changes who does a visit, the unbooked visits with that
 * number move to the new person. One-off changes on other visits stay.
 */
export async function reassignUnbooked(
  clientId: number,
  before: { visit_assessors: (number | null)[]; assessor_id: number | null },
  after: { visit_assessors: (number | null)[]; assessor_id: number | null; visit_months: number[] },
): Promise<void> {
  for (let seq = 1; seq <= after.visit_months.length; seq++) {
    const was = planAssessor(before, seq);
    const now = planAssessor(after, seq);
    if (was !== now) {
      await query(
        "update visits set assessor_id = $3, updated_at = now() where client_id = $1 and seq = $2 and status = 'to_book'",
        [clientId, seq, now],
      );
    }
  }
}

export async function syncAllVisits(): Promise<void> {
  const rows = await query<{ id: number }>("select id from clients");
  for (const r of rows) await syncClientVisits(r.id);
}

/** Looks up any client or assessor postcodes that have no location yet. */
export async function geocodeMissing(): Promise<{ looked: number; found: number }> {
  const clients = await query<{ id: number; postcode: string }>(
    `select id, postcode from clients
      where postcode is not null and (geocoded_postcode is distinct from postcode or lat is null)`,
  );
  const assessors = await query<{ id: number; home_postcode: string }>(
    "select id, home_postcode from assessors where home_postcode is not null and home_lat is null",
  );
  const all = [...clients.map((c) => c.postcode), ...assessors.map((a) => a.home_postcode)];
  if (all.length === 0) return { looked: 0, found: 0 };
  const found = await lookupPostcodes(all);
  let n = 0;
  for (const c of clients) {
    const p = found.get(normalisePostcode(c.postcode) ?? "");
    await query("update clients set lat = $2, lng = $3, geocoded_postcode = $4 where id = $1", [
      c.id, p?.lat ?? null, p?.lng ?? null, c.postcode,
    ]);
    if (p) n++;
  }
  for (const a of assessors) {
    const p = found.get(normalisePostcode(a.home_postcode) ?? "");
    if (p) {
      await query("update assessors set home_lat = $2, home_lng = $3 where id = $1", [a.id, p.lat, p.lng]);
      n++;
    }
  }
  return { looked: all.length, found: n };
}
