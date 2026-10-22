import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEntry,
  balances,
  buildCashCount,
  buildCustomerPayment,
  buildExpense,
  buildPrice,
  buildSale,
  buildStockIn,
  buildSupplierPayment,
  daySummary,
  findItem,
  isBalanced,
  partyBalances,
  removeEntry,
  stockLevels,
  trialBalance,
  unitsSold,
} from "../public/js/ledger.js";
import { sampleBooks, SAMPLE_MESSAGES } from "../public/js/shop.js";

const NOW = "2026-10-23T09:15:00.000Z";
const books = () => ({ ...sampleBooks("2026-10-23"), now: NOW });

test("the opening books balance and hold the demo shop's float, stock and tab", () => {
  const b = books();
  assert.ok(trialBalance(b).balanced);
  const bal = balances(b);
  assert.equal(bal.cash, 4000);
  assert.equal(bal.mobile, 1250);
  assert.equal(partyBalances(b, "debtors")["Baba Farai"], 400);
  assert.equal(stockLevels(b)["eggs-tray"], 3);
});

test("items are found by id, name, plural or local name, and a tie is not guessed", () => {
  const b = books();
  assert.equal(findItem(b, "bread").id, "bread");
  assert.equal(findItem(b, "Cooking oil 2 L").id, "cooking-oil-2l");
  assert.equal(findItem(b, "mazai").id, "eggs-tray");
  assert.equal(findItem(b, "mukaka").id, "milk-1l");
  assert.equal(findItem(b, "loaves").id, "bread");
  assert.equal(findItem(b, "upfu").id, "maize-meal-10kg");
  assert.equal(findItem(b, "peanut butter"), null);
});

test("a cash sale at list prices moves cash, sales, cost of sales and stock", () => {
  const b = books();
  const r = buildSale(b, { items: [{ item: "bread", qty: 3 }, { item: "cooking-oil-2l", qty: 2 }], payment: "cash" });
  assert.ok(r.ok);
  assert.ok(isBalanced(r.entry));
  assert.equal(r.entry.amount, 1230);
  const after = applyEntry(b, r.entry);
  const s = daySummary(after);
  assert.equal(s.sales, 1230);
  assert.equal(s.cash, 1230);
  assert.equal(s.cogs, 3 * 85 + 2 * 360);
  assert.equal(stockLevels(after).bread, 15);
  assert.ok(trialBalance(after).balanced);
});

test("a credit sale needs a customer and lands on their tab", () => {
  const b = books();
  assert.equal(buildSale(b, { items: [{ item: "sugar-2kg", qty: 2 }], payment: "credit" }).ok, false);
  const r = buildSale(b, { items: [{ item: "sugar-2kg", qty: 2 }, { item: "maize-meal-10kg", qty: 1 }], payment: "credit", customer: "mai tendai" });
  assert.ok(r.ok);
  const after = applyEntry(b, r.entry);
  assert.equal(partyBalances(after, "debtors")["Mai Tendai"], 520 + 750);
  assert.equal(daySummary(after).credit, 1270);
  assert.ok(r.warnings.some((w) => w.includes("Maize meal") && w.includes("reorder")));
});

test("a sale of an unknown item asks instead of guessing", () => {
  const r = buildSale(books(), { items: [{ item: "paraffin", qty: 1 }], payment: "cash" });
  assert.equal(r.ok, false);
  assert.match(r.question, /paraffin/);
});

test("the amount the owner received wins over list prices, within reason", () => {
  const b = books();
  const r = buildSale(b, { items: [{ item: "bread", qty: 2 }], payment: "cash", amount_received: 2.0 });
  assert.ok(r.ok);
  assert.equal(r.entry.amount, 200);
  assert.ok(r.warnings[0].includes("$2.20"));
  assert.equal(buildSale(b, { items: [{ item: "bread", qty: 2 }], payment: "cash", amount_received: 50 }).ok, false);
});

test("selling more than the books hold is recorded with a warning", () => {
  const r = buildSale(books(), { items: [{ item: "eggs-tray", qty: 5 }], payment: "mobile" });
  assert.ok(r.ok);
  assert.ok(r.warnings[0].startsWith("Your books show only 3"));
});

test("stock in from an invoice on account adds stock at cost, a new item and a creditor", () => {
  const b = books();
  const r = buildStockIn(b, {
    supplier: "Kudzai Wholesale",
    paid: "credit",
    total: 88.5,
    items: [
      { item: "cooking-oil-2l", qty: 12, unit_cost: 3.6 },
      { item: "Sugar 2 kg", qty: 10, unit_cost: 2.1 },
      { item: "soap-bar", qty: 24, unit_cost: 0.55 },
      { item: "Peanut butter 375 g", qty: 6, unit_cost: 1.85 },
    ],
  });
  assert.ok(r.ok);
  assert.equal(r.entry.amount, 8850);
  assert.ok(r.warnings.some((w) => w.includes("Sugar 2 kg cost $2.10")));
  assert.ok(r.warnings.some((w) => w.includes("Peanut butter 375 g is new")));
  const after = applyEntry(b, r.entry);
  assert.equal(stockLevels(after)["cooking-oil-2l"], 21);
  assert.equal(stockLevels(after)["peanut-butter-375-g"], 6);
  assert.equal(after.items["peanut-butter-375-g"].price, null);
  assert.equal(partyBalances(after, "creditors")["Kudzai Wholesale"], -8850);
  assert.ok(trialBalance(after).balanced);
});

test("an invoice whose lines do not add up to its total is flagged", () => {
  const r = buildStockIn(books(), { supplier: "Kudzai Wholesale", paid: "cash", total: 50, items: [{ item: "salt-1kg", qty: 10, unit_cost: 0.4 }] });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes("not the $50.00")));
});

test("expenses, customer and supplier payments each balance and move the right money", () => {
  let b = books();
  const e = buildExpense(b, { category: "Electricity", amount: 5, payment: "cash" });
  b = applyEntry(b, e.entry);
  const p = buildCustomerPayment(b, { customer: "Baba Farai", amount: 4, method: "cash" });
  b = applyEntry(b, p.entry);
  assert.equal(partyBalances(b, "debtors")["Baba Farai"], 0);
  assert.equal(balances(b).cash, 4000 - 500 + 400);
  assert.equal(daySummary(b).expenses, 500);
  assert.equal(buildCustomerPayment(b, { customer: "Nobody Known", amount: 1, method: "cash" }).ok, false);
  const s = buildSupplierPayment(b, { supplier: "Kudzai Wholesale", amount: 10, method: "mobile" });
  assert.ok(s.ok && isBalanced(s.entry));
});

test("the till count works out the difference and books it as cash over or short", () => {
  const b = books();
  const short = buildCashCount(b, { counted_cash: 38 });
  assert.equal(short.diff, -200);
  const after = applyEntry(b, short.entry);
  assert.equal(balances(after).cash, 3800);
  assert.equal(buildCashCount(b, { counted_cash: 40 }).entry, null);
});

test("a price change below cost is allowed with a warning", () => {
  const r = buildPrice(books(), { item: "bread", sell_price: 0.8 });
  assert.ok(r.ok);
  assert.ok(r.warnings[0].includes("below"));
});

test("undo removes a record but never the opening balances", () => {
  const b = books();
  const r = buildExpense(b, { category: "Transport", amount: 2, payment: "cash" });
  const after = applyEntry(b, r.entry);
  assert.equal(removeEntry(after, r.entry.id).journal.length, 1);
  assert.equal(removeEntry(after, "opening").journal.length, 2);
});

test("an entry that does not balance is refused", () => {
  assert.throws(() => applyEntry(books(), { id: "x", at: NOW, kind: "sale", lines: [{ account: "cash", debit: 100 }, { account: "sales", credit: 90 }], stock: [] }));
});

test("the week's movement includes the past six days and today's sales", () => {
  const b = books();
  const r = buildSale(b, { items: [{ item: "bread", qty: 3 }], payment: "cash" });
  assert.equal(unitsSold(applyEntry(b, r.entry)).bread, 73);
});

test("the full demo script keeps the books balanced and ends with the expected till", () => {
  let b = books();
  const steps = [
    buildSale(b, { items: [{ item: "bread", qty: 3 }, { item: "cooking-oil-2l", qty: 2 }], payment: "cash" }),
  ];
  for (const r of steps) b = applyEntry(b, r.entry);
  b = applyEntry(b, buildSale(b, { items: [{ item: "eggs-tray", qty: 1 }, { item: "milk-1l", qty: 2 }], payment: "mobile" }).entry);
  b = applyEntry(b, buildSale(b, { items: [{ item: "sugar-2kg", qty: 2 }, { item: "maize-meal-10kg", qty: 1 }], payment: "credit", customer: "Mai Tendai" }).entry);
  b = applyEntry(b, buildExpense(b, { category: "Electricity", amount: 5, payment: "cash" }).entry);
  b = applyEntry(b, buildExpense(b, { category: "Transport", amount: 2, payment: "cash" }).entry);
  b = applyEntry(b, buildCustomerPayment(b, { customer: "Baba Farai", amount: 4, method: "cash" }).entry);
  assert.equal(balances(b).cash, 4930);
  const count = buildCashCount(b, { counted_cash: 47.3 });
  assert.equal(count.diff, -200);
  assert.ok(trialBalance(applyEntry(b, count.entry)).balanced);
  assert.ok(SAMPLE_MESSAGES.some((m) => m.text.includes("$47.30")));
});
