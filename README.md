# ALPS CRM

ALPS Consultancy's private client system: clients and prospects, visit
planning and booking, tasks for the office, department risk assessments and
SOPs from the ALPS master formats, ComplyTrack populate jobs, quotes, mail
merge and income. It is separate from ComplyTrack.

Who sees what:

- **Owner** (Steuart): everything, including prices, contract values, the
  Income page, quote prices and approvals, Settings and backups.
- **Staff** (for example Ayesha, Elinor): everything except money. Prices are
  left out of every page and of the mail-merge download, and a staff save
  never changes them.
- **Office person** (a tick on a staff login): new tasks, document requests and
  "please rebook" requests from clients go to them by default.

Every sign-in needs a password and a 6-digit code from an authenticator app.

## What's in it

| Page | What it does |
| --- | --- |
| Today | Your tasks, documents to create, visits to book this month, invites to chase, things waiting for the owner |
| Clients | Search and filter; each client has legal name, trading name, address, contacts, services, contract dates, visit plan, log of calls and notes, tasks, chasers, quotes, documents |
| Visits | Month planner per assessor, in driving order from their home and split into trips; each visit shows type (Fire, Food, General H&S, Compliance), days and allowed weekdays |
| Visit page | Book, warn about wrong weekdays, clashes and days away, email calendar invites with Accept / Ask for another date links, free-date suggestions, nearby visits to book alongside |
| Documents | Department RA and SOP requests; download the master format with the client's details filled in, upload the finished file, owner approves or sends back |
| Missing details | Clients with gaps (no email, legal name, visit types…) for the office to fill in |
| Income | Owner only: monthly and yearly income, by assessor, type, group and service, won and lost this year, open quotes |

## Visits

A client's plan lists up to four visits a year: month, type, number of days
(1 to 5) and who does it (blank means the usual assessor). The CRM creates
each year's visits from the plan. Visits not booked yet follow changes to the
plan; booked and done visits are never changed by it. Months that have already
passed are not created after the fact.

Multi-day visits run on consecutive working days (weekends are skipped unless
the client accepts weekend visits).

Routes use straight-line distances between postcodes, looked up with
[postcodes.io](https://postcodes.io) (free, UK open data; only the postcode is
sent). Add each assessor's home postcode in Settings.

Each visit in the planner shows the miles from the previous stop (or from
home) with a rough drive time, plus free Google Maps and Apple Maps links for
real times and traffic. Each trip has a "Whole trip in Google Maps" link from
home and back. The rough time assumes roads a third longer than a straight
line at about 40 mph.

## Document templates

The RA and SOP master formats are loaded on first start from `templates/`.
Templates use ordinary Word mail-merge fields named like the old spreadsheet
columns (`Company_Name`, `Address_1`, `Address_2`, `Address_3`, `Post_Code`,
…). `Company_Name` becomes "legal name t/a trading name" when the client has a
separate legal name. `[Client / Site Name]` in the text is filled in too. The
full list is on Documents > Word templates. Prices are never filled in.

## Running it locally

Needs Node 22.18+ (Render uses 24) and PostgreSQL.

```sh
npm install
cp .env.example .env.local.sh   # then turn each line into "export NAME=value"
. ./.env.local.sh
npm start                        # http://localhost:3000, /setup the first time
npm run typecheck
npm test                         # logic tests
TEST_DATABASE_URL=postgres://…/alpscrm_test npm run test:app   # wipes that database
```

There is no build step: Node runs the TypeScript directly.

## Putting it on Render

1. In Render, **New > Blueprint**, pick this repository. It creates the
   `alps-crm` web service and the `alps-crm-db` database in Frankfurt
   (about £10-11 a month together).
2. When it's live, open the service's **Environment** page and copy
   `SETUP_TOKEN`. Go to `https://<the address>/setup`, paste it, and create
   the owner account. `/setup` only works while there are no accounts.
3. Sign in, set up the code app, then **Settings > Bring in the client
   spreadsheet** and upload the mail-merge .xlsx. Rows with a 0 or blank fee
   come in as former clients. The "Date" column is read as the contract start.
4. In Settings add Ayesha (tick "Office person") and anyone else, the
   assessors' emails and home postcodes, and the price list.
5. For email, set `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_REPLY_TO` on the
   Environment page (the ComplyTrack Resend account can send from the same
   domain). Until then nothing is emailed, and each screen says so.
6. Optional: a web address such as `crm.alpsconsultancy.co.uk` (Settings >
   Custom Domains on Render, plus a CNAME at one.com), then set
   `PUBLIC_APP_URL` to it.

## Nightly copy on the Mac

`scripts/mac-backup.sh` downloads everything (except passwords and sign-in
codes) into `~/Documents/ALPS CRM backups`, keeping 60 copies. To run it at
1am each night, save this as
`~/Library/LaunchAgents/uk.co.alpsconsultancy.crm-backup.plist`, filling in the
three values, then run
`launchctl load ~/Library/LaunchAgents/uk.co.alpsconsultancy.crm-backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>uk.co.alpsconsultancy.crm-backup</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>/PATH/TO/alps-crm/scripts/mac-backup.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CRM_URL</key><string>https://THE-CRM-ADDRESS</string>
    <key>BACKUP_TOKEN</key><string>COPY-FROM-RENDER</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
```

The backup file holds client personal data: keep the Mac's disk encrypted
(FileVault).

## Code layout

- `src/server.ts` start-up: migrations, master templates, twice-daily visit sync and postcode lookups
- `src/app.ts` Express app, security headers, sessions, same-site form check
- `src/migrate.ts` database schema (add new migrations at the end; never edit a shipped one)
- `src/auth.ts` sign-in, authenticator codes, first-run owner set-up
- `src/routes/` pages: `clients`, `visits`, `work` (tasks, chasers, populate), `quotes`, `documents`, `overview` (Today, Income, Groups), `gaps`, `settings`, `exports`
- `src/visits.ts` visit plan to visits, postcode lookups; `src/geo.ts` distances and route order
- `src/invites.ts` calendar invite emails and the public Accept / Ask for another date pages; `src/ics.ts` .ics files
- `src/docgen.ts` fills Word merge fields; `src/import.ts` the spreadsheet import
