// Visits to tick off. Steuart, 18 Nov 2026: "allow consultants to tick
// completion, reminder if outstanding". A booked visit whose last day has
// passed but isn't marked done is outstanding. The consultant gets one email
// listing all of theirs the morning after, then every 3 days until ticked.
import { query } from "./db.ts";
import { appUrl, sendMail } from "./email.ts";
import { todayUk } from "./html.ts";
import { visitDates, dateRangeText } from "./routes/visits.ts";

export const REMIND_EVERY_DAYS = 3;
const SEND_FROM_HOUR = 8; // UK time

export type Outstanding = {
  id: number; client_id: number; client_name: string; booked_on: string; days: number; visit_weekdays: number[];
  assessor_id: number | null; assessor_name: string | null; assessor_email: string | null; assessor_user_id: number | null;
  done_reminded_on: string | null; last_day: string; dates: string;
};

/** Booked visits whose last day is before today. Optionally only one login's own visits. */
export async function outstandingVisits(userId?: number): Promise<Outstanding[]> {
  const today = todayUk();
  const rows = await query<Omit<Outstanding, "last_day" | "dates">>(
    `select v.id, v.client_id, c.name as client_name, v.booked_on, v.days, c.visit_weekdays, v.done_reminded_on,
            v.assessor_id, a.name as assessor_name, coalesce(a.email, u.email) as assessor_email, a.user_id as assessor_user_id
       from visits v join clients c on c.id = v.client_id
       left join assessors a on a.id = v.assessor_id left join users u on u.id = a.user_id and u.active
      where v.status = 'booked' and v.booked_on < $1 ${userId ? "and a.user_id = $2" : ""}
      order by v.booked_on`,
    userId ? [today, userId] : [today],
  );
  return rows
    .map((v) => {
      const dates = visitDates(v.booked_on, v.days, v.visit_weekdays);
      return { ...v, last_day: dates[dates.length - 1] ?? v.booked_on, dates: dateRangeText(dates) };
    })
    .filter((v) => v.last_day < today);
}

function londonHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" }).format(now));
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** One email per consultant listing their visits to tick off, when any is due a reminder. */
export async function sendDoneReminders(opts: { now?: Date; force?: boolean } = {}): Promise<number> {
  if (!opts.force && londonHour(opts.now) < SEND_FROM_HOUR) return 0;
  const today = todayUk();
  const all = await outstandingVisits();
  const byPerson = new Map<string, Outstanding[]>();
  for (const v of all) {
    if (!v.assessor_email) continue;
    const list = byPerson.get(v.assessor_email) ?? [];
    list.push(v);
    byPerson.set(v.assessor_email, list);
  }
  let emails = 0;
  for (const [to, visits] of byPerson) {
    const due = visits.some((v) => !v.done_reminded_on || daysBetween(v.done_reminded_on, today) >= REMIND_EVERY_DAYS);
    if (!due) continue;
    const name = visits[0].assessor_name?.split(" ")[0] ?? "there";
    await sendMail({
      to,
      subject: visits.length === 1 ? `Please tick off your visit to ${visits[0].client_name}` : `Please tick off ${visits.length} visits`,
      text: [
        `Hello ${name},`,
        "",
        `${visits.length === 1 ? "This visit has" : "These visits have"} finished but ${visits.length === 1 ? "isn't" : "aren't"} marked done in the ALPS CRM yet:`,
        "",
        ...visits.map((v) => `- ${v.client_name}, ${v.dates}: ${appUrl()}/visits/${v.id}`),
        "",
        `Tick each one off on your Today page (${appUrl()}/) or the visit's page. If it didn't happen, open the visit and unbook or cancel it.`,
        `You'll get a reminder every ${REMIND_EVERY_DAYS} days until they're ticked.`,
      ].join("\n"),
    });
    await query("update visits set done_reminded_on = $2 where id = any($1::int[])", [visits.map((v) => v.id), today]);
    emails++;
  }
  return emails;
}
