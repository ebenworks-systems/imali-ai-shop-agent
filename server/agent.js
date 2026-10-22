// The agent. Nemotron 3 Nano reads every message and calls tools; the ledger turns each call into a
// checked double-entry proposal; Nemotron 3.5 Super VL reads photos; Nemotron 3 Super answers the
// questions that need thought and takes over when Nano's tool calls keep failing; Nemotron 3 Ultra
// closes the day. Nothing reaches the books until the owner confirms in the app.

import {
  BUILDERS,
  applyEntry,
  balances,
  buildCashCount,
  daySummary,
  money,
  partyBalances,
  snapshotForModel,
  stockReport,
  unitsSold,
} from "../public/js/ledger.js";

const PAYMENT = { type: "string", enum: ["cash", "mobile_money", "credit"] };
const METHOD = { type: "string", enum: ["cash", "mobile_money"] };
const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const TOOLS = [
  fn(
    "record_sale",
    "Record one sale to a customer. Leave unit_price out to use the catalogue price.",
    {
      items: {
        type: "array",
        items: { type: "object", properties: { item: { type: "string", description: "catalogue id" }, qty: { type: "number" }, unit_price: { type: "number" } }, required: ["item", "qty"] },
      },
      payment: PAYMENT,
      customer: { type: "string", description: "needed when payment is credit" },
      amount_received: { type: "number", description: "only when the owner states the total received" },
    },
    ["items", "payment"],
  ),
  fn(
    "record_stock_in",
    "Record stock received from a supplier, with what each unit cost.",
    {
      supplier: { type: "string" },
      items: {
        type: "array",
        items: { type: "object", properties: { item: { type: "string", description: "catalogue id, or the name on the invoice for a new item" }, qty: { type: "number" }, unit_cost: { type: "number" } }, required: ["item", "qty", "unit_cost"] },
      },
      paid: { type: "string", enum: ["cash", "mobile_money", "on_account"] },
      total: { type: "number", description: "the total printed on the invoice, if there is one" },
    },
    ["supplier", "items", "paid"],
  ),
  fn("record_expense", "Record one running cost paid out of the business (rent, electricity, transport, wages).", { category: { type: "string" }, amount: { type: "number" }, payment: METHOD }, ["category", "amount", "payment"]),
  fn("record_customer_payment", "Record a customer paying back what they owe.", { customer: { type: "string" }, amount: { type: "number" }, method: METHOD }, ["customer", "amount", "method"]),
  fn("record_supplier_payment", "Record paying a supplier what the shop owes them.", { supplier: { type: "string" }, amount: { type: "number" }, method: METHOD }, ["supplier", "amount", "method"]),
  fn("record_owner_withdrawal", "Record money the owner took out of the business for themselves.", { amount: { type: "number" }, method: METHOD, note: { type: "string" } }, ["amount", "method"]),
  fn("set_price", "Change the selling price of one catalogue item.", { item: { type: "string" }, sell_price: { type: "number" } }, ["item", "sell_price"]),
  fn("get_figures", "Read figures from the books: today's sales and profit, stock levels, who owes the shop, or money on hand.", { about: { type: "string", enum: ["today", "stock", "who_owes", "money"] } }, ["about"]),
  fn("ask_analyst", "Pass a question that needs thought (what to restock, what sells slowly, why profit moved, pricing advice) to a stronger model that reads the whole book.", { question: { type: "string" } }, ["question"]),
  fn("close_day", "Close the day: compare the cash the owner counted with what the books expect, and write the day's summary.", { counted_cash: { type: "number" } }, ["counted_cash"]),
];

const WRITE_TOOLS = new Set(Object.keys(BUILDERS));
const LIMITS = { message: 600, historyItems: 6, historyText: 600, imageBytes: 3_500_000, journal: 600, booksBytes: 400_000 };

export function routerPrompt(snapshot) {
  const { shop } = snapshot;
  return [
    `You are the agent inside Imali AI. You keep the books for ${shop.owner}, who runs ${shop.name} in ${shop.place}. Money is in US dollars. Today is ${snapshot.today}.`,
    "Turn each message into the right records with the tools, then reply in one to three short sentences.",
    "",
    "Rules:",
    "- One tool call per transaction. A message can hold several transactions: two costs paid are two record_expense calls.",
    "- Use catalogue ids for items. Owners write in English, chiShona, isiNdebele or a mix; also_called lists the local names (mazai is eggs, mukaka is milk, chingwa is bread).",
    "- Never invent a price or a quantity. Leave unit_price out to use the catalogue price. Pass amount_received only when the owner states the total they received.",
    "- Mobile money covers EcoCash, OneMoney, InnBucks and bank transfers. On credit, chikwereti or 'will pay later' means payment credit, with the customer's name.",
    "- A photo reading arrives as JSON after the owner's words. A supplier invoice or delivery note becomes one record_stock_in with each line's unit cost. Take how it was paid from the owner's words first, then the invoice; if neither says, ask.",
    "- Questions about today's figures, stock, money on hand or who owes: call get_figures and answer with its numbers.",
    "- Advice or analysis (what to restock, what sells slowly, why, how to price): call ask_analyst.",
    "- Closing the day or a till count: call close_day with the counted cash.",
    "- When a tool answers with a question, ask the owner that question and record nothing else for that transaction.",
    "- Reply in the language the owner wrote in. Plain words, no markdown, no emoji. Say what will be recorded; the owner confirms each record with one tap.",
    "",
    "The books right now:",
    JSON.stringify(snapshot),
  ].join("\n");
}

export function stripThinking(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\*\*/g, "")
    .trim();
}

// Some deployments return tool calls as text in the content. Read those too.
export function toolCallsOf(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls;
  const out = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = re.exec(String(message.content ?? "")))) {
    try {
      const parsed = JSON.parse(m[1]);
      out.push({ id: `text-${out.length}`, type: "function", function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}) } });
    } catch {
      out.push({ id: `text-${out.length}`, type: "function", function: { name: "unreadable", arguments: "{}" } });
    }
  }
  return out;
}

function normaliseArgs(name, args) {
  const a = { ...args };
  for (const k of ["payment", "method", "paid"]) if (a[k] === "mobile_money") a[k] = "mobile";
  if (name === "record_stock_in" && a.paid === "on_account") a.paid = "credit";
  return a;
}

export function figures(books, about) {
  const s = daySummary(books);
  const b = balances(books);
  if (about === "stock")
    return { stock: stockReport(books).map((r) => ({ item: r.name, in_stock: r.qty, reorder_at: r.reorderAt, low: r.low })) };
  if (about === "who_owes")
    return {
      customers_owe_you: Object.entries(partyBalances(books, "debtors")).filter(([, v]) => v > 0).map(([name, v]) => ({ name, owes: money(v) })),
      you_owe_suppliers: Object.entries(partyBalances(books, "creditors")).filter(([, v]) => v < 0).map(([name, v]) => ({ name, owed: money(-v) })),
    };
  if (about === "money") return { cash_in_till: money(b.cash), mobile_money: money(b.mobile), customers_owe_you: money(b.debtors), you_owe_suppliers: money(-b.creditors) };
  return {
    day: s.day,
    sales: money(s.sales),
    paid_in_cash: money(s.cash),
    paid_by_mobile_money: money(s.mobile),
    on_credit: money(s.credit),
    cost_of_what_was_sold: money(s.cogs),
    gross_profit: money(s.grossProfit),
    running_costs: money(s.expenses),
    profit_after_costs: money(s.net),
    collected_from_customers: money(s.collected),
    records_today: s.count,
  };
}

function bookForAnalyst(books) {
  const sold = unitsSold(books, 7);
  return {
    ...snapshotForModel(books),
    units_sold_last_7_days: Object.fromEntries(Object.entries(sold).map(([id, q]) => [books.items[id]?.name ?? id, q])),
    todays_records: books.journal.filter((e) => e.kind !== "opening" && e.at.startsWith(books.today)).map((e) => ({ at: e.at.slice(11, 16), what: e.memo, amount: e.amount ? money(e.amount) : undefined })),
  };
}

async function askAnalyst({ chat, models, books, question, ownerWords }) {
  const res = await chat({
    model: models.analyst,
    purpose: "analyst",
    maxTokens: 1200,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are a careful small-business adviser inside Imali AI. Answer the owner's question from the books given, with real item names and numbers from them. Be specific and practical. At most 110 words, plain sentences, no markdown, no emoji. Reply in the language of the owner's own words.",
      },
      { role: "user", content: `Owner's words: ${ownerWords}\nQuestion: ${question}\nBooks: ${JSON.stringify(bookForAnalyst(books))}` },
    ],
  });
  return { text: stripThinking(res.message.content), trace: res.trace };
}

async function closeDay({ chat, models, books, counted, ownerWords }) {
  const count = buildCashCount(books, { counted_cash: counted });
  if (!count.ok) return { question: count.question };
  const s = daySummary(books);
  const facts = {
    till: { expected: money(count.expected), counted: money(count.counted), difference: money(count.diff), result: count.diff === 0 ? "exact" : count.diff < 0 ? "short" : "over" },
    today: figures(books, "today"),
    low_stock: stockReport(books).filter((r) => r.low).map((r) => `${r.name}: ${r.qty} left`),
    records: bookForAnalyst(books).todays_records,
  };
  const res = await chat({
    model: models.closer,
    purpose: "closer",
    maxTokens: 1500,
    temperature: 0.2,
    timeout: 55_000,
    messages: [
      {
        role: "system",
        content:
          "You close a small shop's day inside Imali AI. From the facts given: say in one sentence how the day went (sales and profit after costs). If the till is short or over, give the two most likely reasons from today's records (for example a credit sale or mobile money payment entered as cash, change given wrongly, a cost paid from the till and not recorded) and say what to check. Then list what to reorder tomorrow. At most 120 words, plain sentences, no markdown, no emoji. Reply in the language of the owner's own words.",
      },
      { role: "user", content: `Owner's words: ${ownerWords}\nFacts: ${JSON.stringify(facts)}` },
    ],
  });
  return { text: stripThinking(res.message.content), trace: res.trace, count, summary: s };
}

export async function readPhoto({ chat, models, image }) {
  const res = await chat({
    model: models.vision,
    purpose: "photo reader",
    maxTokens: 1200,
    temperature: 0,
    json: true,
    messages: [
      {
        role: "system",
        content:
          'You read photos for a small shop\'s stock book. The photo may be a supplier invoice, a delivery note, a handwritten stock list or a till slip. Reply with JSON only, with exactly these keys: {"kind":"invoice|delivery_note|stock_list|receipt|other","supplier":string|null,"date":string|null,"items":[{"name":string,"qty":number,"unit_cost":number|null,"line_total":number|null}],"total":number|null,"paid":"cash|mobile_money|on_account|unknown","notes":string}. Copy numbers exactly as printed. Use null for anything you cannot read.',
      },
      { role: "user", content: [{ type: "text", text: "Read this photo." }, { type: "image_url", image_url: { url: image } }] },
    ],
  });
  const text = stripThinking(res.message.content).replace(/^```(?:json)?|```$/g, "").trim();
  let reading;
  try {
    reading = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    reading = null;
  }
  if (!reading || !Array.isArray(reading.items)) return { reading: null, trace: res.trace };
  reading.items = reading.items
    .filter((it) => it && typeof it.name === "string")
    .slice(0, 40)
    .map((it) => ({ name: it.name.slice(0, 60), qty: Number(it.qty) || null, unit_cost: it.unit_cost === null ? null : Number(it.unit_cost) || null, line_total: it.line_total === null ? null : Number(it.line_total) || null }));
  return { reading, trace: res.trace };
}

export function validateRequest(body) {
  if (!body || typeof body !== "object") return "Send a JSON body.";
  const { message = "", image, books, history = [] } = body;
  if (typeof message !== "string" || message.length > LIMITS.message) return `Keep the message under ${LIMITS.message} characters.`;
  if (!message.trim() && !image) return "Type a message or add a photo.";
  if (image !== undefined && (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > LIMITS.imageBytes)) return "The photo must be a JPEG, PNG or WebP under about 2.5 MB.";
  if (!Array.isArray(history) || history.length > 20) return "History is malformed.";
  for (const h of history) if (!h || !["user", "assistant"].includes(h.role) || typeof h.content !== "string") return "History is malformed.";
  if (!books || typeof books !== "object" || !books.items || !Array.isArray(books.journal) || !books.shop) return "The books are missing.";
  if (books.journal.length > LIMITS.journal || JSON.stringify(books).length > LIMITS.booksBytes) return "The demo books are full. Reset the demo to start again.";
  return null;
}

export async function runAgent({ chat, models, books, message = "", image, history = [], now = new Date().toISOString() }) {
  const trace = [];
  const proposals = [];
  const seen = new Set();
  let working = { ...structuredClone(books), now };
  let photo;
  let words = message.trim();

  if (image) {
    const read = await readPhoto({ chat, models, image });
    trace.push(read.trace);
    photo = read.reading;
    words = `${words || "Here is a photo."}\n\nPhoto reading from ${models.vision.label} (JSON): ${photo ? JSON.stringify(photo) : '{"error":"the photo could not be read"}'}`;
  }

  const messages = [
    { role: "system", content: routerPrompt(snapshotForModel(working)) },
    ...history.slice(-LIMITS.historyItems).map((h) => ({ role: h.role, content: h.content.slice(0, LIMITS.historyText) })),
    { role: "user", content: words },
  ];

  let model = models.router;
  let failures = 0;
  let escalated = false;
  const done = (reply, extra = {}) => ({ reply, proposals, trace, photo, escalated, ...extra });

  for (let round = 0; round < 6; round += 1) {
    const res = await chat({ model, purpose: escalated ? "router, retried on Super" : "router", messages, tools: TOOLS, maxTokens: 1200, temperature: 0.1 });
    trace.push(res.trace);
    const calls = toolCallsOf(res.message);
    if (!calls.length) {
      const text = stripThinking(res.message.content);
      if (text) return done(text);
      failures += 1;
      messages.push({ role: "user", content: "Reply to the owner in one to three short sentences." });
      continue;
    }
    messages.push({ role: "assistant", content: res.message.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });

    for (const call of calls) {
      const name = call.function?.name;
      let args;
      try {
        args = normaliseArgs(name, JSON.parse(call.function?.arguments || "{}"));
      } catch {
        args = null;
      }
      let result;
      if (!args || !TOOLS.some((t) => t.function.name === name)) {
        failures += 1;
        result = { error: `The call to ${name || "an unknown tool"} could not be read. Use one of the tools with valid JSON arguments.` };
      } else if (WRITE_TOOLS.has(name)) {
        const key = `${name}:${JSON.stringify(args)}`;
        if (seen.has(key)) {
          result = { ok: true, note: "Already recorded above." };
        } else {
          seen.add(key);
          const built = BUILDERS[name](working, args);
          if (!built.ok) result = { question: built.question };
          else {
            const proposal = { id: `p${proposals.length + 1}-${Date.now().toString(36)}`, tool: name, warnings: built.warnings || [] };
            if (built.entry) {
              working = applyEntry(working, built.entry);
              Object.assign(proposal, { entry: built.entry, summary: built.entry.memo, amount: built.entry.amount });
            } else if (built.price) {
              Object.assign(proposal, { price: built.price, summary: `New price for ${built.price.name}: ${money(built.price.to)}` });
            }
            proposals.push(proposal);
            result = { ok: true, will_record: proposal.summary, warnings: proposal.warnings };
          }
        }
      } else if (name === "get_figures") {
        result = figures(working, args.about);
      } else if (name === "ask_analyst") {
        const a = await askAnalyst({ chat, models, books: working, question: String(args.question || message).slice(0, 400), ownerWords: message });
        trace.push(a.trace);
        if (a.text) return done(a.text, { answeredBy: models.analyst.label });
        result = { error: "The analyst could not answer. Answer briefly yourself." };
      } else if (name === "close_day") {
        const c = await closeDay({ chat, models, books: working, counted: args.counted_cash, ownerWords: message });
        if (c.question) result = { question: c.question };
        else {
          trace.push(c.trace);
          if (c.count.entry) {
            proposals.push({ id: `p${proposals.length + 1}-${Date.now().toString(36)}`, tool: "close_day", entry: c.count.entry, summary: c.count.entry.memo, amount: c.count.entry.amount, warnings: [] });
          }
          const till = { expected: c.count.expected, counted: c.count.counted, diff: c.count.diff };
          if (c.text) return done(c.text, { answeredBy: models.closer.label, till });
          result = { till: { expected: money(till.expected), counted: money(till.counted), difference: money(till.diff) } };
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    if (failures >= 2 && !escalated) {
      model = models.analyst;
      escalated = true;
    }
  }
  return done(proposals.length ? "I've prepared the records above. Tap to confirm each one." : "Sorry, I could not work that out. Could you say it another way?");
}
