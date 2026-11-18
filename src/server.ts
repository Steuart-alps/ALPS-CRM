import { migrate } from "./migrate.ts";
import { createApp, seedTemplates } from "./app.ts";
import { geocodeMissing, syncAllVisits } from "./visits.ts";
import { recordCompletion } from "./routes/gaps.ts";

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
