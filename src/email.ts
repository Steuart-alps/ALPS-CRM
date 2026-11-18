// Sends email through Resend's HTTP API. Without RESEND_API_KEY the message
// is only logged, so the CRM still works before email is set up.

export function appUrl(): string {
  return (process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
}

export type Attachment = { filename: string; content: string; contentType: string };
export type Mail = { to: string; subject: string; text: string; attachments?: Attachment[] };

const sent: Mail[] = [];
/** Tests read what would have been sent. */
export function sentMail(): Mail[] {
  return sent;
}

export async function sendMail(mail: Mail): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  // RESEND_FROM_EMAIL is ComplyTrack's name for the same setting, so both work.
  const from = process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL;
  if (!key || !from) {
    sent.push(mail);
    console.log(`email (not sent, email not set up): to=${mail.to} subject=${JSON.stringify(mail.subject)}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
        ...(mail.attachments?.length
          ? {
              attachments: mail.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content).toString("base64"),
                content_type: a.contentType,
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`email failed (${res.status}) to=${mail.to}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("email failed", err);
    return false;
  }
}
