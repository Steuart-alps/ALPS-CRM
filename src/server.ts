import { migrate } from "./migrate.ts";
import { createApp, seedTemplates } from "./app.ts";
import { geocodeMissing, syncAllVisits } from "./visits.ts";
import { recordCompletion } from "./routes/gaps.ts";
import { sendDoneReminders } from "./reminders.ts";

async function housekeeping(): Promise<void> {
  try {
    await syncAllVisits();
  } catch (err) {
    console.error("visit sync failed", err);
  }
  try {
    await recordCompletion();
  } catch (err) {
    console.error("completion record failed", err);
  }
  try {
    await geocodeMissing();
  } catch (err: any) {
    console.error("postcode lookup failed", err?.message ?? err);
  }
}

await migrate();
await seedTemplates();
const app = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`ALPS CRM listening on ${port}`));

// Adds each new year's visits and places new postcodes, twice a day.
void housekeeping();
setInterval(() => void housekeeping(), 12 * 60 * 60 * 1000).unref();

// Reminders to tick off finished visits: checked hourly, sent from 8am UK time.
const remind = () => void sendDoneReminders().catch((err) => console.error("visit reminders failed", err));
remind();
setInterval(remind, 60 * 60 * 1000).unref();
