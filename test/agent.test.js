import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, toolCallsOf, validateRequest, stripThinking, routerPrompt } from "../server/agent.js";
import { MODELS } from "../server/nebius.js";
import { snapshotForModel, applyEntry, balances } from "../public/js/ledger.js";
import { sampleBooks } from "../public/js/shop.js";

const NOW = "2026-10-23T10:00:00.000Z";
const call = (name, args, id = `c-${name}`) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

// A stand-in for Token Factory: answers from a script and remembers what it was asked.
function scripted(...replies) {
  const asked = [];
  const chat = async (req) => {
    asked.push({ ...req, messages: structuredClone(req.messages) });
    const next = replies.shift();
    if (!next) throw new Error(`no scripted reply for ${req.purpose}`);
    const message = typeof next === "string" ? { role: "assistant", content: next } : { role: "assistant", content: "", ...next };
    return { message, trace: { role: req.purpose, model: req.model.label, modelId: req.model.id, ms: 5, tokensIn: 100, tokensOut: 20, cost: 0.00001 } };
  };
  return { chat, asked };
}

const books = () => sampleBooks("2026-10-23");

test("a sale message becomes one checked proposal and a short reply, on Nemotron 3.5 Lightning", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_sale", { items: [{ item: "bread", qty: 3 }, { item: "cooking-oil-2l", qty: 2 }], payment: "cash" })] },
    "Got it: 3 bread and 2 cooking oil, $12.30 cash. Tap Record to add it.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Sold 3 bread and 2 cooking oil, cash", now: NOW });
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].amount, 1230);
  assert.equal(out.proposals[0].entry.at, NOW);
  assert.match(out.reply, /12.30/);
  assert.deepEqual(out.trace.map((t) => t.model), ["Nemotron 3.5 Lightning", "Nemotron 3.5 Lightning"]);
  assert.equal(asked[0].model.id, "nvidia/Nemotron-3_5-Lightning");
  assert.ok(asked[0].tools.some((t) => t.function.name === "record_sale"));
  const toolMsg = asked[1].messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.match(toolMsg.content, /will_record/);
});

test("the proposal from the server applies cleanly to the browser's copy of the books", async () => {
  const { chat } = scripted({ tool_calls: [call("record_sale", { items: [{ item: "eggs-tray", qty: 1 }, { item: "milk-1l", qty: 2 }], payment: "mobile_money" })] }, "Recorded by mobile money.");
  const b = books();
  const out = await runAgent({ chat, models: MODELS, books: b, message: "Ndatengesa mazai tray 1 nemukaka 2, ndabhadharwa ne mobile money", now: NOW });
  const after = applyEntry(b, out.proposals[0].entry);
  assert.equal(balances(after).mobile, 1250 + 810);
});

test("a photo goes to Nemotron 3.5 Super VL first, and its reading reaches the router", async () => {
  const reading = { kind: "invoice", supplier: "Kudzai Wholesale", date: "23/10/2026", items: [{ name: "Cooking oil 2 L", qty: 12, unit_cost: 3.6, line_total: 43.2 }], total: 43.2, paid: "unknown", notes: "" };
  const { chat, asked } = scripted(
    { content: JSON.stringify(reading) },
    { tool_calls: [call("record_stock_in", { supplier: "Kudzai Wholesale", items: [{ item: "cooking-oil-2l", qty: 12, unit_cost: 3.6 }], paid: "on_account", total: 43.2 })] },
    "Stock in from Kudzai Wholesale, $43.20 owed.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Delivered today, I pay Friday", image: "data:image/jpeg;base64,AAAA", now: NOW });
  assert.equal(asked[0].model.label, "Nemotron 3.5 Super VL");
  assert.equal(asked[0].messages[1].content[1].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.match(asked[1].messages.at(-1).content, /Photo reading from Nemotron 3.5 Super VL/);
  assert.equal(out.photo.supplier, "Kudzai Wholesale");
  assert.equal(out.proposals[0].entry.party, "Kudzai Wholesale");
  assert.equal(out.proposals[0].entry.method, "credit");
});

test("a question that needs thought is answered by Nemotron 3 Super with the whole book", async () => {
  const { chat, asked } = scripted({ tool_calls: [call("ask_analyst", { question: "What should I restock?" })] }, "Reorder eggs and maize meal before Saturday.");
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "What should I restock before the weekend?", now: NOW });
  assert.equal(out.answeredBy, "Nemotron 3 Super");
  assert.match(out.reply, /eggs/);
  assert.equal(asked[1].model.label, "Nemotron 3 Super");
  assert.match(asked[1].messages[1].content, /units_sold_last_7_days/);
});

test("closing the day counts the till in code and hands the review to Nemotron 3 Ultra", async () => {
  const { chat, asked } = scripted({ tool_calls: [call("close_day", { counted_cash: 38 })] }, "A quiet day. The till is $2.00 short.");
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Closing up, I counted $38", now: NOW });
  assert.equal(out.answeredBy, "Nemotron 3 Ultra");
  assert.deepEqual(out.till, { expected: 4000, counted: 3800, diff: -200 });
  assert.equal(out.proposals[0].tool, "close_day");
  assert.match(asked[1].messages[1].content, /"result":"short"/);
});

test("figures come from the ledger, not from the model", async () => {
  const { chat, asked } = scripted({ tool_calls: [call("get_figures", { about: "money" })] }, "You have $40.00 in the till.");
  await runAgent({ chat, models: MODELS, books: books(), message: "How much cash do I have?", now: NOW });
  assert.match(asked[1].messages.at(-1).content, /"cash_in_till":"\$40.00"/);
});

test("when Lightning's tool calls fail twice, Nemotron 3 Super takes over the message", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_sale", "{not json")] },
    { tool_calls: [call("record_sael", { items: [] })] },
    { tool_calls: [call("record_sale", { items: [{ item: "salt-1kg", qty: 1 }], payment: "cash" })] },
    "One salt, cash.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "1 salt cash", now: NOW });
  assert.equal(out.escalated, true);
  assert.equal(asked[2].model.label, "Nemotron 3 Super");
  assert.equal(asked[2].purpose, "router, retried on Super");
  assert.equal(out.proposals.length, 1);
});

test("a sale whose message never says how it was paid is asked about, whatever the model guessed", async () => {
  const { chat, asked } = scripted({ tool_calls: [call("record_sale", { items: [{ item: "candles-6", qty: 1 }], payment: "cash" })] }, "How did the customer pay?");
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Sold a pack of candles", now: NOW });
  assert.equal(out.proposals.length, 0);
  assert.match(asked[1].messages.at(-1).content, /How did the customer pay/);
});

test("a question from the ledger is passed back so the agent asks the owner", async () => {
  const { chat, asked } = scripted({ tool_calls: [call("record_sale", { items: [{ item: "sugar-2kg", qty: 1 }], payment: "credit" })] }, "Who took it on credit?");
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "sugar on credit", now: NOW });
  assert.equal(out.proposals.length, 0);
  assert.match(asked[1].messages.at(-1).content, /Who took it on credit/);
});

test("a ledger question reaches the owner even when the model's reply skips it", async () => {
  const { chat } = scripted({ content: "", tool_calls: [call("record_sale", { items: [{ item: "candles-6", qty: 1 }], payment: "cash" }), call("reply", { text: "Today's sales: $1.70." })] });
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Sold a pack of candles and a box of matches", now: NOW });
  assert.equal(out.proposals.length, 0);
  assert.match(out.reply, /How did the customer pay/);
});

test("the day is closed only with a count the owner gave, never one the model took from the books", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_owner_withdrawal", { amount: 10, method: "cash", note: "kids' lunch" }), call("close_day", { counted_cash: 40 })] },
    "Noted: you took $10 from the till.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Took $10 from the till for the kids' lunch money", now: NOW });
  assert.equal(out.answeredBy, undefined);
  assert.deepEqual(out.proposals.map((p) => p.tool), ["record_owner_withdrawal"]);
  assert.ok(!asked.some((a) => a.model.label === "Nemotron 3 Ultra"));
  assert.match(asked[1].messages.at(-1).content, /no counted cash/);
});

test("an item the owner's latest message does not name is sent back, however the model found it", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_expense", { category: "Electricity", amount: 5, payment: "cash" }), call("record_sale", { items: [{ item: "bread", qty: 2 }], payment: "mobile" })] },
    "Electricity, $5.00 cash.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Paid $5 for electricity", now: NOW });
  assert.deepEqual(out.proposals.map((p) => p.tool), ["record_expense"]);
  assert.match(asked[1].messages.at(-1).content, /Bread loaf is not in the owner's latest message/);
});

test("the analyst answers questions only, not a message that records something", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_expense", { category: "Transport", amount: 2, payment: "cash" }), call("ask_analyst", { question: "What should I restock?" })] },
    "Transport, $2.00 cash.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Paid $2 transport to town", now: NOW });
  assert.equal(out.answeredBy, undefined);
  assert.ok(!asked.some((x) => x.model.label === "Nemotron 3 Super"));
  assert.equal(out.reply, "Transport, $2.00 cash.");
});

test("a rate is looked up only when the owner's message names another currency", async () => {
  let looked = 0;
  const rates = async () => (looked++, { unitsPerUsd: 26.6, name: "ZiG", source: "example", trace: [] });
  const { chat, asked } = scripted(
    { tool_calls: [call("record_sale", { items: [{ item: "bread", qty: 1 }], payment: "mobile" }), call("get_exchange_rate", { currency: "ZiG" })] },
    "One bread, mobile money.",
  );
  await runAgent({ chat, models: MODELS, books: books(), message: "Sold 1 bread on mobile money", now: NOW, rates });
  assert.equal(looked, 0);
  assert.match(asked[1].messages.at(-1).content, /names no other currency/);
});

test("a price changes only when the owner names the item and the new price", async () => {
  const { chat } = scripted(
    { tool_calls: [call("record_expense", { category: "Electricity", amount: 5, payment: "cash" }), call("set_price", { item: "bread", sell_price: 1.1 })] },
    "Electricity, $5.00 cash.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Paid $5 for electricity", now: NOW });
  assert.deepEqual(out.proposals.map((p) => p.tool), ["record_expense"]);
  const asked = scripted({ tool_calls: [call("set_price", { item: "bread", sell_price: 1.2 })] }, "Bread is now $1.20.");
  const changed = await runAgent({ chat: asked.chat, models: MODELS, books: books(), message: "Change the bread price to $1.20", now: NOW });
  assert.equal(changed.proposals[0].price.to, 120);
});

test("the same transaction called twice in one message is proposed once", async () => {
  const sale = { items: [{ item: "bread", qty: 1 }], payment: "cash" };
  const { chat } = scripted({ tool_calls: [call("record_sale", sale, "a"), call("record_sale", sale, "b")] }, "One bread.");
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "1 bread cash", now: NOW });
  assert.equal(out.proposals.length, 1);
});

test("the first router call must use a tool, and a reply that claims a record without one is sent back", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("reply", { text: "Recorded: 2 bread, cash." })] },
    { tool_calls: [call("record_sale", { items: [{ item: "bread", qty: 2 }], payment: "cash" })] },
    "Two bread, $2.20 cash. Tap Record.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "2 bread cash", now: NOW });
  assert.equal(asked[0].toolChoice, "required");
  assert.equal(asked[1].toolChoice, "auto");
  assert.match(asked[1].messages.at(-1).content, /Nothing was recorded/);
  assert.equal(out.proposals.length, 1);
  assert.match(out.reply, /Tap Record/);
});

test("a greeting is answered through the reply tool with no record", async () => {
  const { chat } = scripted({ tool_calls: [call("reply", { text: "Hello Rudo. Tell me what you sold." })] });
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Hi", now: NOW });
  assert.equal(out.reply, "Hello Rudo. Tell me what you sold.");
  assert.equal(out.proposals.length, 0);
});

test("tool calls written as text in the reply are read too", () => {
  const calls = toolCallsOf({ content: 'ok <tool_call>{"name":"record_expense","arguments":{"category":"Transport","amount":2,"payment":"cash"}}</tool_call>' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "record_expense");
  assert.equal(stripThinking("<think>hmm</think>Done. <tool_call>{}</tool_call>"), "Done.");
});

test("the router prompt carries the catalogue with local names and today's figures", () => {
  const p = routerPrompt(snapshotForModel(books()));
  assert.match(p, /mazai/);
  assert.match(p, /Rudo's Corner Shop/);
  assert.match(p, /today_so_far/);
});

test("requests are checked before any model is called", () => {
  const b = books();
  assert.equal(validateRequest({ message: "hi", books: b }), null);
  assert.match(validateRequest({ message: "", books: b }), /Type a message/);
  assert.match(validateRequest({ message: "x".repeat(601), books: b }), /600/);
  assert.match(validateRequest({ message: "hi", books: b, image: "data:text/html;base64,AAAA" }), /JPEG/);
  assert.match(validateRequest({ message: "hi", books: b, history: [{ role: "system", content: "x" }] }), /History/);
  assert.match(validateRequest({ message: "hi" }), /books/);
});

test("a record reaching back into the history, or a number the owner never gave, is sent back", async () => {
  const { chat, asked } = scripted(
    { tool_calls: [call("record_customer_payment", { customer: "Mai Tendai", amount: 12.7, method: "cash" }), call("record_expense", { category: "Transport", amount: 3, payment: "cash" })] },
    "Done.",
  );
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Paid $2 transport", history: [{ role: "user", content: "Mai Tendai took sugar on credit, she'll pay Friday" }], now: NOW });
  assert.equal(out.proposals.length, 0);
  const results = asked[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  assert.match(results, /Mai Tendai is not named/);
  assert.match(results, /amount is not in the owner's latest message/);
});

test("an exchange rate the owner did not give is looked up, never taken from the model", async () => {
  const { chat } = scripted({ tool_calls: [call("record_sale", { items: [{ item: "bread", qty: 2 }], payment: "mobile_money", paid_currency: "ZiG", paid_amount: 60, rate: 24 })] }, "Done.");
  let looked = 0;
  const rates = async () => (looked++, { unitsPerUsd: 26.5975, name: "ZiG", source: "idbz.co.zw", url: "https://www.idbz.co.zw/x", asOf: null, trace: [] });
  const out = await runAgent({ chat, models: MODELS, books: books(), message: "Sold 2 bread, paid 60 ZiG on mobile money", now: NOW, rates });
  assert.equal(looked, 1);
  assert.equal(out.proposals[0].amount, 226);
});
