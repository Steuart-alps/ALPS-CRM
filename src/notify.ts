import { one } from "./db.ts";
import { appUrl, sendMail } from "./email.ts";
import { ukDate } from "./html.ts";

/** Emails someone when they are given a task or a document to create. */
export async function notifyAssigned(opts: {
  assigneeId: number | null;
  byUserId: number;
  kind: "task" | "document";
  title: string;
  clientId: number | null;
  dueOn: string | null;
  path: string;
}): Promise<void> {
  if (!opts.assigneeId || opts.assigneeId === opts.byUserId) return;
  const to = await one<{ email: string; name: string }>("select email, name from users where id = $1 and active", [opts.assigneeId]);
  const by = await one<{ name: string }>("select name from users where id = $1", [opts.byUserId]);
  if (!to) return;
  const client = opts.clientId ? await one<{ name: string }>("select name from clients where id = $1", [opts.clientId]) : null;
  const what = opts.kind === "task" ? "a task" : "a document to create";
  const lines = [
    `Hi ${to.name.split(" ")[0]},`,
    "",
    `${by?.name ?? "Someone"} has given you ${what} in ALPS CRM:`,
    "",
    opts.title,
    client ? `Client: ${client.name}` : "",
    opts.dueOn ? `Due: ${ukDate(opts.dueOn)}` : "",
    "",
    `Open it: ${appUrl()}${opts.path}`,
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "");
  // Client details stay in the CRM: the email carries only the title, client name and a link.
  await sendMail({ to: to.email, subject: `New ${opts.kind === "task" ? "task" : "document request"}: ${opts.title}`, text: lines.join("\n") });
}
