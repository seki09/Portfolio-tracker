/**
 * flatex.at PDF statement parser — Wertpapierabrechnung (Kauf/Verkauf) and
 * Sammelabrechnung (Wertpapierkauf/-verkauf).
 *
 * Pure: takes positioned text (what pdf.js getTextContent() yields) and returns
 * canonical transactions plus issues. No DOM, no network — the same file runs in
 * the browser (window.Importers["flatex-at-pdf"]) and under Node tests.
 *
 *   input  pages: [[{ str, x, y }]]   one array of text items per page
 *   output { docType, account, transactions: [...], issues: [...] }
 *
 * Every transaction is self-checked: the components must add up to the
 * statement's Endbetrag, and shares × price ÷ FX must match the Kurswert.
 * A failed check becomes an issue on the row — never a silently "fixed" number.
 */
(function (root) {
  "use strict";

  const ID = "flatex-at-pdf";
  const ISIN = "[A-Z]{2}[A-Z0-9]{9}[0-9]";

  /** German number → Number ("1.234,56" → 1234.56, "-9.876,54" → -9876.54). */
  function num(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/\s/g, "");
    if (!/^-?[\d.]*,?\d+$/.test(t)) return null;
    return Number(t.replace(/\./g, "").replace(",", "."));
  }
  const isoDate = d => { const m = /(\d\d)\.(\d\d)\.(\d{4})/.exec(d || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const r2 = n => Math.round(n * 100) / 100;

  /** Group items into visual lines (same baseline ± tolerance), left to right. */
  function toLines(pages) {
    const out = [];
    pages.forEach((items, p) => {
      const rows = [];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        let row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
        if (!row) rows.push(row = { y: it.y, items: [] });
        row.items.push(it);
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) out.push({ page: p + 1, y: r.y, text: r.items.sort((a, b) => a.x - b.x).map(i => i.str.trim()).join(" ") });
    });
    return out;
  }

  /** 0..1 confidence that this text is a flatex.at securities statement. */
  function detect(pages) {
    const all = toLines(pages).map(l => l.text).join("\n");
    if (!/flatex Bank AG/.test(all)) return 0;
    let c = 0.4;
    if (/Niederlassung Österreich|flatex\.at|A-1010 Wien/.test(all)) c += 0.3;
    if (/Wertpapierabrechnung|Sammelabrechnung/.test(all)) c += 0.3;
    return Math.min(1, c);
  }

  function field(text, re) { const m = re.exec(text); return m ? m[1] : null; }

  function parse(pages) {
    const lines = toLines(pages);
    const all = lines.map(l => l.text).join("\n");
    const issues = [];
    const docType = /Sammelabrechnung/.test(all) ? "Sammelabrechnung"
      : /Wertpapierabrechnung\s+(Kauf|Verkauf)/.test(all) ? "Wertpapierabrechnung " + /Wertpapierabrechnung\s+(Kauf|Verkauf)/.exec(all)[1]
      : null;
    const depot = field(all, /Depotnummer:\s*(\d{6,})/);
    const result = { parser: ID, docType, account: depot ? { broker: "flatex.at", depot } : null, transactions: [], issues };

    // One block per order: "Nr.<order>/<part> Kauf|Verkauf <name> (<ISIN>/<WKN>)"
    const head = new RegExp(`^Nr\\.?\\s*(\\d+/\\d+)\\s+(Kauf|Verkauf)\\s+(.+?)\\s*\\((${ISIN})/([A-Z0-9]{6})\\)`);
    const starts = lines.map((l, i) => (head.test(l.text) ? i : -1)).filter(i => i >= 0);
    if (!starts.length) {
      issues.push({ level: "error", code: "UNSUPPORTED_DOCUMENT",
        message: docType ? `No orders found in this ${docType}.` : "This flatex document type isn't supported yet (only buy/sell statements)." });
      return result;
    }

    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const block = lines.slice(s, end).map(l => l.text).join("\n");
      const [, orderNo, side, name, isin, wkn] = head.exec(lines[s].text);
      const rowIssues = [];
      const need = (label, v) => { if (v == null) rowIssues.push({ level: "error", code: "MISSING_FIELD", message: `Couldn't read “${label}”.` }); return v; };

      const shares = need("Ausgeführt", num(field(block, /(?:Ausgeführt|davon ausgef\.)\s*:\s*([\d.,]+)\s*St\./)));
      const priceM = /\bKurs\s*:\s*([\d.,]+)\s*([A-Z]{3})/.exec(block);
      const price = need("Kurs", priceM ? num(priceM[1]) : null), priceCcy = priceM ? priceM[2] : null;
      const fx = num(field(block, /Devisenkurs\s*:\s*([\d.,]+)/)) ?? 1;
      const gross = need("Kurswert", num(field(block, /Kurswert\s*:\s*(-?[\d.,]+)\s*EUR/)));
      const commission = num(field(block, /Provision\s*:\s*(-?[\d.,]+)\s*EUR/)) ?? 0;
      const ownFees = num(field(block, /Eigene Spesen\s*:\s*(-?[\d.,]+)\s*EUR/)) ?? 0;
      const thirdFees = num(field(block, /Fremde Spesen\s*:\s*(-?[\d.,]+)\s*EUR/)) ?? 0;
      const tax = num(field(block, /Einbeh\.\s*(?:KESt|Steuer)\s*:\s*(-?[\d.,]+)\s*EUR/)) ?? 0;
      const realized = num(field(block, /Gewinn\/Verlust:?\s*(-?[\d.,]+)\s*EUR/));
      const endbetrag = need("Endbetrag", num(field(block, /Endbetrag\s*:\s*(-?[\d.,]+)\s*EUR/)));
      const date = need("Handelstag/Schlusstag", isoDate(field(block, /(?:Handelstag|Schlusstag)\s*:?\s*(\d\d\.\d\d\.\d{4})/) || field(all, /Handelstag\s*:?\s*(\d\d\.\d\d\.\d{4})/)));
      const time = field(block, /(?:Ausführungszeit|Schlusstag\s*:?\s*\d\d\.\d\d\.\d{4},?)\s*(\d\d:\d\d)/) || field(all, /Ausführungszeit\s*(\d\d:\d\d)/);
      const valuta = isoDate(field(block, /Valuta\s*:?\s*(\d\d\.\d\d\.\d{4})/) || field(all, /Valuta\s*:?\s*(\d\d\.\d\d\.\d{4})/));
      const venue = field(block, /Handelsplatz\s*:\s*(.+?)(?:\n|$)/) || field(all, /Ausf\.platz\/-art\s*(.+?)(?:\n|$)/);
      const txNo = field(block, /Transaktion-Nr\.:?\s*(\d+)/) || (starts.length === 1 ? field(all, /Transaktion-Nr\.:?\s*(\d+)/) : null);
      const feeLines = {};
      for (const k2 of ["Courtage", "Tradinggebühr", "Regulierung", "Schlussnoten", "LS-Umlegung", "Finanztransaktionssteuer", "Sonstige"]) {
        const v = num(field(block, new RegExp(`${k2}:?\\s*:?\\s*(-?[\\d.,]+)\\s*EUR`)));
        if (v) feeLines[k2] = v;
      }

      const type = side === "Kauf" ? "BUY" : "SELL";
      const fee = r2(commission + ownFees + thirdFees);
      const net = endbetrag == null ? null : (type === "BUY" ? -Math.abs(endbetrag) : endbetrag);

      // ---- self-checks: the statement must add up, or the row says so ----
      if (gross != null && net != null) {
        const expected = type === "BUY" ? -(gross + fee + tax) : gross - fee - tax;
        if (Math.abs(expected - net) > 0.011)
          rowIssues.push({ level: "error", code: "AMOUNTS_DONT_ADD_UP",
            message: `Kurswert ${gross} ${type === "BUY" ? "+" : "−"} fees ${fee} ${type === "BUY" ? "+" : "−"} tax ${tax} = ${r2(expected)}, but Endbetrag is ${net}.` });
      }
      if (shares != null && price != null && gross != null) {
        const implied = (shares * price) / (fx || 1);
        if (Math.abs(implied - gross) > Math.max(0.02, gross * 0.0005))
          rowIssues.push({ level: "warning", code: "PRICE_MISMATCH", message: `${shares} × ${price} ${priceCcy} ÷ ${fx} = ${r2(implied)} EUR, Kurswert says ${gross}.` });
      }
      if (Object.keys(feeLines).length && Math.abs(Object.values(feeLines).reduce((a, b) => a + b, 0) - thirdFees) > 0.011)
        rowIssues.push({ level: "warning", code: "FEE_BREAKDOWN_MISMATCH", message: `Fee breakdown doesn't sum to Fremde Spesen ${thirdFees}.` });

      result.transactions.push({
        source: "flatex.at", parser: ID, orderNo, txNo, type,
        date, time, valuta, venue: venue ? venue.trim() : null,
        name: name.replace(/\s+/g, " ").trim(), isin, wkn,
        shares, price, priceCcy, fx,
        gross, fee, fees: { commission, own: ownFees, thirdParty: thirdFees, breakdown: feeLines },
        tax, realized, net,
        account: depot,
        issues: rowIssues,
      });
    });
    return result;
  }

  const api = { id: ID, label: "flatex.at statement (PDF)", detect, parse, _internals: { num, toLines } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.Importers = root.Importers || {})[ID] = api;
})(typeof window !== "undefined" ? window : globalThis);
