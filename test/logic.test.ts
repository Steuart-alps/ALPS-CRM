import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://localhost/unused";

const { orderStops, splitTrips, miles, normalisePostcode } = await import("../src/geo.ts");
const { buildIcs, londonToUtc, parseTime } = await import("../src/ics.ts");
const { visitDates, isoWeekday } = await import("../src/routes/visits.ts");
const { contractDates } = await import("../src/routes/clients.ts");
const { fillXml } = await import("../src/docgen.ts");
const { toCsv } = await import("../src/routes/exports.ts");
const { parseUkDate, parseMonth } = await import("../src/import.ts");
const { html, money, parseMoney } = await import("../src/html.ts");

const inverness = { lat: 57.4778, lng: -4.2247 };
const nairn = { lat: 57.586, lng: -3.869 };
const fortWilliam = { lat: 56.8198, lng: -5.1052 };
const oban = { lat: 56.415, lng: -5.4718 };

test("route goes to nearby clients before far ones and splits into trips", () => {
  const stops = [
    { id: "oban", point: oban },
    { id: "nairn", point: nairn },
    { id: "fw", point: fortWilliam },
    { id: "nowhere", point: null },
  ];
  const ordered = orderStops(inverness, stops).map((s) => s.id);
  assert.deepEqual(ordered, ["nairn", "fw", "oban", "nowhere"]);
  const trips = splitTrips(orderStops(inverness, stops), 30).map((t) => t.map((s) => s.id));
  assert.deepEqual(trips, [["nairn"], ["fw"], ["oban"], ["nowhere"]]);
  assert.ok(miles(inverness, nairn) > 10 && miles(inverness, nairn) < 20);
});

test("postcodes are tidied", () => {
  assert.equal(normalisePostcode("iv26dh"), "IV2 6DH");
  assert.equal(normalisePostcode(" PA22 3AB "), "PA22 3AB");
  assert.equal(normalisePostcode("nope"), null);
});

test("multi-day visits skip weekends unless the client takes weekend visits", () => {
  // Thu 4 Feb 2027 for 3 days -> Thu, Fri, Mon
  assert.deepEqual(visitDates("2027-02-04", 3), ["2027-02-04", "2027-02-05", "2027-02-08"]);
  assert.deepEqual(visitDates("2027-02-05", 2, [5, 6]), ["2027-02-05", "2027-02-06"]);
  assert.equal(isoWeekday("2027-02-10"), 3);
});

test("contract roll-over and notice date", () => {
  assert.deepEqual(contractDates("2021-11-08", 3, "2026-11-18"), { rollover: "2027-11-08", noticeBy: "2027-08-08" });
  assert.deepEqual(contractDates("2021-12-01", 3, "2026-11-18"), { rollover: "2026-12-01", noticeBy: "2026-09-01" });
  assert.equal(contractDates(null, 3), null);
});

test("calendar invites use London time and group consecutive all-day visits", () => {
  assert.equal(londonToUtc("2027-07-01", "09:30").toISOString(), "2027-07-01T08:30:00.000Z");
  assert.equal(londonToUtc("2027-01-12", "09:30").toISOString(), "2027-01-12T09:30:00.000Z");
  assert.equal(parseTime("2pm"), "14:00");
  assert.equal(parseTime("9.30"), "09:30");
  assert.equal(parseTime("lunch"), null);
  const ics = buildIcs({
    uid: "alps-visit-1@test", sequence: 0, method: "REQUEST", dates: ["2027-02-04", "2027-02-05", "2027-02-08"], time: null,
    summary: "ALPS visit: Test, Hotel", location: "1 Road, Inverness", description: "Accept here", organizer: { name: "ALPS", email: "a@example.test" },
    attendees: [{ name: "Client", email: "c@example.test" }],
  });
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(ics, /DTSTART;VALUE=DATE:20270204\r\nDTEND;VALUE=DATE:20270206/);
  assert.match(ics, /SUMMARY:ALPS visit: Test\\, Hotel/);
  assert.match(ics, /METHOD:REQUEST/);
});

test("Word merge fields are filled and unknown ones left alone", () => {
  const field = (name: string, shown: string) =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> MERGEFIELD ${name} </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${shown}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const xml = `<w:p>${field("Company_Name", "Royal Ashdown")}<w:r><w:t>, </w:t></w:r>${field("Post_Code", "RH18")}${field("Mystery", "keep me")}</w:p><w:p><w:r><w:t>[Client / Site Name]</w:t></w:r></w:p>`;
  const out = fillXml(xml, { companyname: "Ness Ltd t/a Ness & Co", postcode: "IV2 6DH" }, "Ness & Co");
  assert.ok(!out.includes("Royal Ashdown"));
  assert.ok(out.includes("<w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">Ness Ltd t/a Ness &amp; Co</w:t>"));
  assert.ok(out.includes("IV2 6DH"));
  assert.ok(out.includes("keep me"));
  assert.ok(out.includes("Ness &amp; Co</w:t>"));
});

test("CSV cells are quoted and formulas neutralised", () => {
  const csv = toCsv(["A", "B"], [["x, y", "=SUM(1)"], ['say "hi"', null]]);
  assert.equal(csv, '﻿A,B\r\n"x, y",\'=SUM(1)\r\n"say ""hi""",\r\n');
});

test("spreadsheet dates and months", () => {
  assert.equal(parseUkDate("7th May 2021"), "2021-05-07");
  assert.equal(parseUkDate("22nd September 2025"), "2025-09-22");
  assert.equal(parseUkDate("07/05/2021"), "2021-05-07");
  assert.equal(parseUkDate("sometime"), null);
  assert.equal(parseMonth("February"), 2);
  assert.equal(parseMonth("sept"), null);
  assert.equal(parseMonth("Sep"), 9);
});

test("html escapes values and money formats", () => {
  assert.equal(html`<p>${"<b>&"}</p>`.value, "<p>&lt;b&gt;&amp;</p>");
  assert.equal(money(15000), "£150");
  assert.equal(money(1250), "£12.50");
  assert.equal(parseMoney("£1,200"), 120000);
  assert.equal(parseMoney(""), null);
});
