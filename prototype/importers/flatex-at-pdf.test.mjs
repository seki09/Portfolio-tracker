// node --test prototype/importers/*.test.mjs
// Synthetic fixtures always run. Real statements run only when present locally:
//   FLATEX_REAL_DIR=imports/flatex PDFJS=<path to pdfjs-dist/legacy/build/pdf.js> node --test prototype/importers/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const parser = require("./flatex-at-pdf.js");
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/flatex-at/${name}`, import.meta.url), "utf8")).pages;

test("buy statement (Wertpapierabrechnung Kauf Fonds/Zertifikate)", () => {
  const pages = fixture("kauf-fonds-synthetic.json");
  assert.equal(parser.detect(pages), 1);
  const r = parser.parse(pages);
  assert.equal(r.docType, "Wertpapierabrechnung Kauf");
  assert.deepEqual(r.issues, []);
  assert.equal(r.transactions.length, 1);
  const t = r.transactions[0];
  assert.deepEqual(
    { type: t.type, date: t.date, time: t.time, valuta: t.valuta, isin: t.isin, wkn: t.wkn, shares: t.shares, price: t.price,
      priceCcy: t.priceCcy, fx: t.fx, gross: t.gross, fee: t.fee, tax: t.tax, net: t.net, orderNo: t.orderNo, txNo: t.txNo, venue: t.venue },
    { type: "BUY", date: "2024-03-12", time: "10:15", valuta: "2024-03-14", isin: "IE00B4L5Y983", wkn: "A0RPWH", shares: 40, price: 25.5,
      priceCcy: "EUR", fx: 1, gross: 1020, fee: 8.64, tax: 0, net: -1028.64, orderNo: "100000001/1", txNo: "9000000001", venue: "Lang & Schwarz" });
  assert.deepEqual(t.fees, { commission: 5.9, own: 0, thirdParty: 2.74, breakdown: { Regulierung: 2.7, Schlussnoten: 0.04 } });
  assert.deepEqual(t.issues, []);
});

test("sell in a foreign currency with KESt (Sammelabrechnung)", () => {
  const r = parser.parse(fixture("sammelabrechnung-verkauf-synthetic.json"));
  assert.equal(r.docType, "Sammelabrechnung");
  const t = r.transactions[0];
  assert.deepEqual(
    { type: t.type, date: t.date, time: t.time, valuta: t.valuta, isin: t.isin, shares: t.shares, price: t.price, priceCcy: t.priceCcy,
      fx: t.fx, gross: t.gross, fee: t.fee, tax: t.tax, realized: t.realized, net: t.net, venue: t.venue, name: t.name },
    { type: "SELL", date: "2024-06-18", time: "17:42", valuta: "2024-06-20", isin: "US5949181045", shares: 5, price: 180, priceCcy: "USD",
      fx: 1.09, gross: 825.69, fee: 15.92, tax: 57.75, realized: 210, net: 752.02, venue: "NASDAQ", name: "MICROSOFT CORP." });
  assert.deepEqual(t.issues, []);
});

test("amounts that don't add up are flagged, not corrected", () => {
  const pages = fixture("kauf-fonds-synthetic.json").map(p => p.map(i => (i.str === "-1.028,64" ? { ...i, str: "-1.030,00" } : i)));
  const t = parser.parse(pages).transactions[0];
  assert.equal(t.net, -1030);
  assert.ok(t.issues.some(i => i.code === "AMOUNTS_DONT_ADD_UP"));
});

test("unknown flatex document types are rejected explicitly", () => {
  const pages = fixture("kauf-fonds-synthetic.json").map(p => p.filter(i => !/^Nr\.\d/.test(i.str)));
  const r = parser.parse(pages);
  assert.equal(r.transactions.length, 0);
  assert.equal(r.issues[0].code, "UNSUPPORTED_DOCUMENT");
});

test("non-flatex text is not detected", () => {
  assert.equal(parser.detect([[{ str: "DADAT Bank Umsatzliste", x: 70, y: 700 }]]), 0);
});

test("German numbers", () => {
  const { num } = parser._internals;
  assert.equal(num("1.234,56"), 1234.56);
  assert.equal(num("-9.876,54"), -9876.54);
  assert.equal(num("1,090000"), 1.09);
  assert.equal(num("abc"), null);
});

// ---- real statements: local only, expected values live next to the PDFs (gitignored) ----
const realDir = process.env.FLATEX_REAL_DIR, pdfjsPath = process.env.PDFJS;
test("real flatex.at statements (local)", { skip: !(realDir && pdfjsPath && existsSync(`${realDir}/expected.json`)) && "set FLATEX_REAL_DIR and PDFJS" }, async () => {
  const pdfjs = require(pdfjsPath);
  const expected = JSON.parse(readFileSync(`${realDir}/expected.json`, "utf8"));
  for (const file of readdirSync(`${realDir}/pdf`).filter(f => f.endsWith(".pdf"))) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${realDir}/pdf/${file}`)) }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++)
      pages.push((await (await doc.getPage(p)).getTextContent()).items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5] })));
    const r = parser.parse(pages);
    assert.deepEqual(r.issues, [], file);
    assert.deepEqual(r.transactions.map(({ fees, ...t }) => t), expected[file], file);
  }
});
