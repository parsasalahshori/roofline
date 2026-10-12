import { describe, expect, test } from "vitest";
import {
  calculateQuote,
  defaultPricebook,
  defaultScope,
  money,
  type QuoteView,
} from "@roofline/shared";
import { renderQuotePdf, type QuotePdfInput } from "../src/quotes/pdf.ts";

/** Pure: no app, no database. Runs locally. */

const CREATED = "2026-10-12T15:00:00.000Z";
const CALCULATION = calculateQuote(defaultScope, defaultPricebook);

function quoteView(overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    number: "Q-0001",
    status: "draft",
    measurement: {
      source: "manual",
      areaSqFt: defaultScope.areaSqFt,
      areaType: defaultScope.areaType,
      pitch: defaultScope.pitch,
      notes: null,
    },
    scope: defaultScope,
    prices: defaultPricebook,
    calculation: CALCULATION,
    notes: null,
    validUntil: "2026-11-11",
    createdAt: CREATED,
    finalizedAt: null,
    canEdit: true,
    ...overrides,
  } as QuoteView;
}

function input(
  quote: QuoteView = quoteView(),
  timeZone = "America/Chicago",
): QuotePdfInput {
  return {
    quote,
    company: {
      name: "Summit Roofing Co.",
      phone: "+14025550199",
      email: "office@example.com",
      website: "https://example.com",
      address: "1200 Farnam St, Omaha, NE 68102",
    },
    customer: {
      name: "Pat Homeowner",
      phone: "+14025550123",
      email: "pat@example.com",
    },
    address: "101 Oak St, Omaha, NE 68102",
    timeZone,
  };
}

/** Renders the document and collects its bytes. */
function render(i: QuotePdfInput, compress?: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = renderQuotePdf(
      i,
      compress === undefined ? undefined : { compress },
    );
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const PDF_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** Decodes one PDF literal string body (the bytes between the parentheses). */
function unescapeLiteral(body: string): string {
  let out = "";
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[k + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(k + 1))![0];
      out += String.fromCharCode(parseInt(oct, 8));
      k += oct.length;
    } else {
      out += PDF_ESCAPES[next] ?? next;
      k += 1;
    }
  }
  return out;
}

/** Maps a WinAnsi byte to its character, so the em dash and middle dot read as written. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0xb7: "·",
  0x80: "€",
};
const fromWinAnsi = (s: string): string =>
  [...s].map((ch) => WIN_ANSI_HIGH[ch.charCodeAt(0)] ?? ch).join("");

/**
 * The text a content stream shows, one line per text operator. Pdfkit writes standard-font text as
 * `[<hex> -12 <hex>] TJ` (kerning splits) or `(literal) Tj`; the pieces of one operator join without a
 * separator, and separate operators are separate lines.
 */
function textOf(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const token = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>|\b(TJ|Tj)\b/g;
  const lines: string[] = [];
  let current = "";
  for (const m of raw.matchAll(token)) {
    if (m[3] !== undefined) {
      lines.push(current);
      current = "";
    } else if (m[1] !== undefined) {
      current += fromWinAnsi(unescapeLiteral(m[1]));
    } else {
      const hex = m[2]!.replace(/\s+/g, "");
      let decoded = "";
      for (let k = 0; k + 1 < hex.length; k += 2)
        decoded += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      current += fromWinAnsi(decoded);
    }
  }
  lines.push(current);
  return lines.join("\n");
}

describe("renderQuotePdf (uncompressed, text is searchable)", () => {
  test("a draft starts with the PDF header and shows the number, total, dates and footer", async () => {
    const buf = await render(input(), false);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const text = textOf(buf);
    expect(text).toContain("Q-0001");
    expect(text).toContain(money(CALCULATION.totalCents));
    expect(text).toContain("Roofing estimate");
    expect(text).toContain("Created Oct 12, 2026");
    expect(text).toContain("Valid through Nov 11, 2026");
    expect(text).toContain("Estimate total");
    expect(text).toContain("Prepared with Roofline");
  });

  test("a draft says it is not final; a final quote says Final and not the draft line", async () => {
    const draft = textOf(
      await render(input(quoteView({ status: "draft" })), false),
    );
    expect(draft).toContain("Q-0001 · Draft — not final");

    const final = textOf(
      await render(
        input(quoteView({ status: "final", finalizedAt: CREATED })),
        false,
      ),
    );
    expect(final).toContain("Q-0001 · Final");
    expect(final).not.toContain("Draft — not final");
  });

  test("the created date is shown in the company zone, not in UTC", async () => {
    // 2026-10-13 02:30 UTC is still Oct 12 evening in America/Chicago (CDT, UTC-5).
    const late = quoteView({ createdAt: "2026-10-13T02:30:00.000Z" });
    const text = textOf(await render(input(late, "America/Chicago"), false));
    expect(text).toContain("Created Oct 12, 2026");
    expect(text).not.toContain("Oct 13, 2026");
  });
});

describe("renderQuotePdf (default compression)", () => {
  test("the default output is a PDF whose page text is compressed, not plain in the raw bytes", async () => {
    const buf = await render(input());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.includes(Buffer.from("Prepared with Roofline", "latin1"))).toBe(
      false,
    );
  });
});
