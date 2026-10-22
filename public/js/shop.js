// The demo shop. Every name, price and figure here is invented for the demonstration.

const ITEMS = [
  ["bread", "Bread loaf", "loaf", ["bread", "chingwa", "isinkwa", "loaf", "loaves"], 1.1, 0.85, 18, 6],
  ["cooking-oil-2l", "Cooking oil 2 L", "bottle", ["cooking oil", "oil", "mafuta", "amafutha"], 4.5, 3.6, 9, 4],
  ["sugar-2kg", "Sugar 2 kg", "pack", ["sugar", "shuga", "ushukela"], 2.6, 2.05, 14, 5],
  ["maize-meal-10kg", "Maize meal 10 kg", "bag", ["maize meal", "mealie meal", "upfu", "impuphu", "mealiemeal"], 7.5, 6.2, 4, 3],
  ["rice-2kg", "Rice 2 kg", "pack", ["rice", "mupunga", "irayisi"], 2.8, 2.2, 10, 4],
  ["eggs-tray", "Eggs, tray of 30", "tray", ["eggs", "egg tray", "mazai", "amaqanda"], 5.5, 4.4, 3, 2],
  ["milk-1l", "Fresh milk 1 L", "carton", ["milk", "mukaka", "uchago"], 1.3, 1.0, 12, 4],
  ["salt-1kg", "Salt 1 kg", "pack", ["salt", "munyu", "itshwayi"], 0.6, 0.4, 15, 5],
  ["soap-bar", "Bath soap", "bar", ["soap", "sipo", "insipho"], 0.8, 0.55, 20, 6],
  ["matches", "Matches, box of 10", "box", ["matches", "machisi", "umentshisi"], 0.5, 0.35, 12, 4],
  ["candles-6", "Candles, pack of 6", "pack", ["candles", "makenduru", "amakhandlela"], 1.2, 0.9, 3, 3],
  ["soft-drink-2l", "Soft drink 2 L", "bottle", ["soft drink", "cool drink", "soda", "fizzy"], 1.8, 1.3, 10, 4],
];

export const DEMO_DAY = "2026-10-23";

// Units sold over the six days before today, so the analyst has a week of movement to read.
const PAST_WEEK = { bread: 70, "cooking-oil-2l": 14, "sugar-2kg": 18, "maize-meal-10kg": 9, "rice-2kg": 3, "eggs-tray": 6, "milk-1l": 30, "salt-1kg": 2, "soap-bar": 16, matches: 10, "candles-6": 9, "soft-drink-2l": 5 };

export function sampleBooks(today = DEMO_DAY) {
  const items = {};
  const stock = [];
  let stockCost = 0;
  for (const [id, name, unit, aliases, price, cost, qty, reorderAt] of ITEMS) {
    items[id] = { id, name, unit, aliases, price: Math.round(price * 100), cost: Math.round(cost * 100), reorderAt };
    stock.push({ item: id, qty, unitCost: Math.round(cost * 100) });
    stockCost += Math.round(cost * 100) * qty;
  }
  const opening = `${today}T06:00:00.000Z`;
  return {
    version: 1,
    shop: { name: "Rudo's Corner Shop", place: "Harare", owner: "Rudo", currency: "USD" },
    today,
    items,
    pastWeek: { ...PAST_WEEK },
    customers: [{ name: "Baba Farai" }, { name: "Mai Tendai" }],
    suppliers: [{ name: "Kudzai Wholesale" }],
    journal: [
      {
        id: "opening",
        at: opening,
        kind: "opening",
        memo: "Opening balances: till float, stock on the shelves, Baba Farai's tab",
        lines: [
          { account: "cash", debit: 4000 },
          { account: "mobile", debit: 1250 },
          { account: "stock", debit: stockCost },
          { account: "debtors", debit: 400, party: "Baba Farai" },
          { account: "capital", credit: 4000 + 1250 + stockCost + 400 },
        ],
        stock,
      },
    ],
  };
}

export const SAMPLE_MESSAGES = [
  { label: "Sold 3 bread and 2 cooking oil, cash", text: "Sold 3 bread and 2 cooking oil, cash" },
  { label: "Shona: eggs and milk by mobile money", text: "Ndatengesa mazai tray 1 nemukaka 2, ndabhadharwa ne mobile money" },
  { label: "Mai Tendai, on credit", text: "Mai Tendai took 2 sugar and a 10kg mealie meal on credit, she'll pay Friday" },
  { label: "Photo of a supplier invoice", photo: "samples/invoice-kudzai-wholesale.jpg", text: "Kudzai Wholesale just delivered this. I will pay them on Friday." },
  { label: "Paid electricity and transport", text: "Paid $5 for electricity and $2 transport to town" },
  { label: "Baba Farai paid back", text: "Baba Farai paid back his $4 in cash" },
  { label: "How much did I make today?", text: "How much did I make today?" },
  { label: "What should I restock?", text: "What should I restock before the weekend, and what is selling slowly?" },
  { label: "Close the day", text: "Closing up now. I counted $47.30 in the till." },
];
