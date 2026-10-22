// The page: the chat, the proposal cards and the live books. The books live in this browser only.

import { ACCOUNTS, applyEntry, applyPrice, balances, daySummary, money, partyBalances, removeEntry, stockReport, trialBalance, fmtQty } from "./js/ledger.js";
import { SAMPLE_MESSAGES, sampleBooks } from "./js/shop.js";

const STORE_KEY = "imali-shop-agent-demo:v1";
const $ = (sel, root = document) => root.querySelector(sel);
const bind = (name) => document.querySelector(`[data-bind="${name}"]`);

const ICONS = {
  record_sale: '<path d="M4 7h16l-1.4 9.2a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  record_stock_in: '<path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z"/><path d="m3.5 8 8.5 4 8.5-4M12 12v8"/>',
  record_expense: '<path d="M5 4.5h14v15l-2.4-1.6-2.3 1.6-2.3-1.6-2.3 1.6-2.3-1.6L5 19.5z"/><path d="M8.5 9h7M8.5 12.5h5"/>',
  record_customer_payment: '<path d="M4 7.5h16v10H4z"/><circle cx="12" cy="12.5" r="2.4"/><path d="M7 7.5V6M17 7.5V6"/>',
  record_supplier_payment: '<path d="M4 7.5h16v10H4z"/><path d="M8 12.5h8M13.5 10l2.5 2.5-2.5 2.5"/>',
  record_owner_withdrawal: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  set_price: '<path d="M4 12.5 11.5 5H19v7.5L11.5 20z"/><circle cx="15.5" cy="8.5" r="1.3"/>',
  close_day: '<path d="M12 4a8 8 0 1 0 8 8"/><path d="M12 8v4.5l3 1.8"/>',
};
const ROLE_TEXT = {
  router: ["tier-router", "read the message and called the tools"],
  "router, retried on Super": ["tier-retry", "took over after Nano's tool calls failed"],
  "photo reader": ["tier-vision", "read the photo"],
  analyst: ["tier-analyst", "answered from the whole book"],
  closer: ["tier-closer", "closed the day"],
  "rate search": ["tier-tavily", "searched the web for today's official rate"],
  "rate reader": ["tier-router", "read the rate, its date and source"],
};

let state = load();
let pendingPhoto = null;
let busy = false;

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowLocal(today) {
  const d = new Date();
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${today}T${t}.000Z`;
}

function fresh() {
  return { books: sampleBooks(todayLocal()), thread: [], session: { cost: 0, calls: 0 } };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved?.books?.journal && saved.books.today === todayLocal()) return saved;
  } catch {}
  return fresh();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast("This browser could not save the demo books.");
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function svg(paths, cls = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = paths;
  return s;
}

function toast(text) {
  const t = $(".toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
}

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtCost = (c) => `$${c < 0.0001 && c > 0 ? c.toFixed(6) : c.toFixed(4)}`;
const fmtTok = (n) => `${n.toLocaleString("en-US")} tokens`;
const accountName = (key) => ACCOUNTS[key]?.name ?? key;

// ---- the thread ----------------------------------------------------------------------------

function renderThread() {
  const list = $(".thread");
  list.replaceChildren(
    el("li", { class: "msg welcome" }, `This is ${state.books.shop.owner}'s shop. Tell the agent what happened today, or tap one of the examples below.`),
    ...state.thread.map(renderItem),
  );
  list.scrollTop = list.scrollHeight;
}

function renderItem(item) {
  if (item.type === "owner") {
    return el("li", { class: "msg msg-owner" }, el("div", { class: "bubble" }, item.image ? el("img", { src: item.image, alt: "Photo sent to the agent", width: 320, height: 240 }) : null, item.text || ""));
  }
  if (item.type === "error") return el("li", { class: "msg msg-agent msg-error" }, el("div", { class: "bubble" }, item.text));
  const li = el("li", { class: "msg msg-agent", "data-id": item.id });
  li.append(el("div", { class: "bubble" }, item.text));
  if (item.proposals?.length) li.append(el("div", { class: "proposals" }, item.proposals.map((p) => renderProposal(item, p))));
  if (item.trace?.length) {
    const total = item.trace.reduce((a, t) => ({ ms: a.ms + t.ms, cost: a.cost + t.cost }), { ms: 0, cost: 0 });
    const models = [...new Set(item.trace.map((t) => t.model))];
    li.append(el("div", { class: "meta" }, models.map((m) => el("span", { class: "chip" }, el("b", {}, m))), el("span", {}, `${fmtMs(total.ms)} · ${fmtCost(total.cost)}`)));
  }
  return li;
}

function renderProposal(item, p) {
  const card = el("div", { class: `prop ${p.state === "done" ? "done" : ""} ${p.state === "skipped" ? "skipped" : ""}`, "data-pid": p.id });
  const amount = p.amount ? money(p.amount) : p.price ? money(p.price.to) : "";
  card.append(el("div", { class: "prop-top" }, el("span", { class: "prop-icon" }, svg(ICONS[p.tool] || ICONS.record_sale)), el("span", { class: "prop-text" }, p.summary), amount ? el("span", { class: "prop-amount" }, amount) : null));
  for (const w of p.warnings || []) card.append(el("p", { class: "prop-warn" }, w));
  if (p.rate?.url) card.append(el("p", { class: "prop-rate" }, `Rate found by live search: ${p.rate.unitsPerUsd} ${p.rate.currency} to the US dollar, `, el("a", { href: p.rate.url, target: "_blank", rel: "noopener" }, p.rate.source), p.rate.asOf ? `, ${p.rate.asOf}` : ""));
  if (p.entry) {
    card.append(
      el(
        "ul",
        { class: "prop-lines", "aria-label": "Double entry" },
        p.entry.lines.map((l) => el("li", {}, el("span", { class: "dc" }, l.debit ? "Dr" : "Cr"), el("span", {}, accountName(l.account) + (l.party ? ` · ${l.party}` : "")), el("span", {}, money(l.debit || l.credit)))),
      ),
    );
  }
  if (p.state === "done") {
    card.append(el("div", { class: "prop-state" }, "Recorded in the books", el("button", { type: "button", onclick: () => undo(item.id, p.id) }, "Undo")));
  } else if (p.state === "skipped") {
    card.append(el("div", { class: "prop-state" }, "Not recorded"));
  } else {
    card.append(
      el(
        "div",
        { class: "prop-actions" },
        el("button", { type: "button", class: "btn btn-primary", onclick: () => record(item.id, p.id) }, "Record", el("span", { class: "knob" }, svg('<path d="M5 12.5 10 17 19 7.5"/>'))),
        el("button", { type: "button", class: "btn btn-ghost", onclick: () => skip(item.id, p.id) }, "Not this"),
      ),
    );
  }
  return card;
}

function refreshItem(itemId) {
  const item = state.thread.find((t) => t.id === itemId);
  const old = $(`.msg[data-id="${itemId}"]`);
  if (item && old) old.replaceWith(renderItem(item));
}

function findProposal(itemId, pid) {
  const item = state.thread.find((t) => t.id === itemId);
  return [item, item?.proposals.find((p) => p.id === pid)];
}

function record(itemId, pid) {
  const [, p] = findProposal(itemId, pid);
  if (!p || p.state === "done") return;
  const before = state.books;
  try {
    if (p.entry) state.books = applyEntry(state.books, p.entry);
    else if (p.price) state.books = applyPrice(state.books, p.price);
  } catch {
    toast("That record no longer fits the books. Ask the agent again.");
    return;
  }
  p.state = "done";
  save();
  refreshItem(itemId);
  renderBooks(before);
}

function skip(itemId, pid) {
  const [, p] = findProposal(itemId, pid);
  if (!p || p.state) return;
  p.state = "skipped";
  save();
  refreshItem(itemId);
}

function undo(itemId, pid) {
  const [, p] = findProposal(itemId, pid);
  if (!p || p.state !== "done") return;
  const before = state.books;
  if (p.entry) state.books = removeEntry(state.books, p.entry.id);
  else if (p.price) state.books = applyPrice(state.books, { ...p.price, to: p.price.from });
  p.state = undefined;
  save();
  refreshItem(itemId);
  renderBooks(before);
  toast("Taken out of the books.");
}

function undoEntry(entryId) {
  for (const item of state.thread) for (const p of item.proposals || []) if (p.entry?.id === entryId && p.state === "done") return undo(item.id, p.id);
  const before = state.books;
  state.books = removeEntry(state.books, entryId);
  save();
  renderBooks(before);
}

// ---- the books -----------------------------------------------------------------------------

function setValue(name, text) {
  const node = bind(name);
  if (!node || node.textContent === text) return;
  node.textContent = text;
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

function countUp(node, from, to) {
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = money(to);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 900);
    const e = 1 - Math.pow(1 - k, 4);
    node.textContent = money(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderBooks(before) {
  const books = state.books;
  const s = daySummary(books);
  const prev = before ? daySummary(before) : s;
  bind("day").textContent = new Date(`${books.today}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  countUp(bind("sales"), prev.sales, s.sales);
  setValue("cash-sales", money(s.cash));
  setValue("mobile-sales", money(s.mobile));
  setValue("credit-sales", money(s.credit));
  setValue("gross", money(s.grossProfit));
  setValue("costs", money(s.expenses));
  setValue("net", money(s.net));

  const b = balances(books);
  const tb = trialBalance(books);
  const badge = bind("balanced");
  badge.textContent = tb.balanced ? "Balanced" : "Out of balance";
  badge.classList.toggle("bad", !tb.balanced);
  bind("accounts").replaceChildren(
    ...[
      ["cash", b.cash],
      ["mobile", b.mobile],
      ["debtors", b.debtors],
      ["stock", b.stock],
      ["creditors", -b.creditors],
    ].map(([k, v]) => el("li", {}, el("span", {}, accountName(k)), el("span", {}, money(v)))),
  );
  bind("tb").textContent = `Debits ${money(tb.debit)} = credits ${money(tb.credit)} across ${books.journal.length} ${books.journal.length === 1 ? "entry" : "entries"}`;

  const beforeLevels = before ? Object.fromEntries(stockReport(before).map((r) => [r.id, r.qty])) : {};
  const rows = stockReport(books);
  const top = Math.max(...rows.map((r) => r.qty), 1);
  bind("stock").replaceChildren(
    ...rows.map((r) =>
      el(
        "li",
        { class: `${r.low ? "low" : ""} ${before && beforeLevels[r.id] !== r.qty ? "changed" : ""}` },
        el("span", {}, r.name),
        el("span", { class: "qty" }, `${fmtQty(r.qty)}${r.low ? " · reorder" : ""}`),
        el("span", { class: "bar" }, el("i", { style: `transform: scaleX(${Math.max(0, r.qty) / top})` })),
      ),
    ),
  );
  const low = rows.filter((r) => r.low).length;
  bind("low-count").textContent = low ? `${low} to reorder` : "All stocked";

  const debtors = Object.entries(partyBalances(books, "debtors")).filter(([, v]) => v !== 0);
  const creditors = Object.entries(partyBalances(books, "creditors")).filter(([, v]) => v !== 0);
  const owed = [
    ...debtors.map(([n, v]) => el("li", {}, el("span", {}, el("span", { class: "side" }, "Owes you"), n), el("span", {}, money(v)))),
    ...creditors.map(([n, v]) => el("li", {}, el("span", {}, el("span", { class: "side" }, "You owe"), n), el("span", {}, money(-v)))),
  ];
  bind("owed").replaceChildren(...(owed.length ? owed : [el("li", { class: "empty" }, "Nobody owes anybody.")]));

  const entries = books.journal.filter((e) => e.kind !== "opening").slice().reverse();
  bind("entries").textContent = String(entries.length);
  bind("journal").replaceChildren(
    ...(entries.length
      ? entries.map((e) =>
          el(
            "li",
            {},
            el("div", { class: "j-top" }, el("span", {}, e.memo), el("span", { class: "j-time" }, e.at.slice(11, 16))),
            el(
              "ul",
              { class: "j-lines" },
              el("li", { class: "j-head" }, el("span", {}, "Account"), el("span", { class: "n" }, "Debit"), el("span", { class: "n" }, "Credit")),
              e.lines.map((l) => el("li", { class: l.credit ? "cr" : "" }, el("span", {}, accountName(l.account) + (l.party ? ` · ${l.party}` : "")), el("span", { class: "n" }, l.debit ? money(l.debit) : ""), el("span", { class: "n" }, l.credit ? money(l.credit) : ""))),
            ),
            el("button", { type: "button", class: "undo", onclick: () => undoEntry(e.id) }, "Undo this record"),
          ),
        )
      : [el("li", { class: "empty" }, "Nothing recorded yet today. The opening balances are in place: $40.00 float in the till, $12.50 on mobile money, the stock on the shelves and Baba Farai's $4.00 tab.")]),
  );
}

function renderRoute(trace) {
  const list = bind("route");
  if (!trace?.length) return;
  const total = trace.reduce((a, t) => ({ ms: a.ms + t.ms, cost: a.cost + t.cost, tok: a.tok + t.tokensIn + t.tokensOut }), { ms: 0, cost: 0, tok: 0 });
  list.replaceChildren(
    ...trace.map((t, i) => {
      const [tier, words] = ROLE_TEXT[t.role] || ["tier-router", t.role];
      return el(
        "li",
        { class: `step ${tier}`, style: `animation-delay:${i * 90}ms` },
        el("span", { class: "r-n" }, String(i + 1)),
        el("span", { class: "r-main" }, el("span", { class: "r-model" }, t.model), el("span", { class: "r-role" }, words)),
        el("span", { class: "r-num" }, `${fmtMs(t.ms)}`, el("br"), t.modelId?.startsWith("tavily") ? "1 search credit" : `${fmtTok(t.tokensIn + t.tokensOut)} · ${fmtCost(t.cost)}`),
      );
    }),
    el("li", { class: "r-total" }, el("span", {}, `This message: ${trace.filter((t) => !t.modelId?.startsWith("tavily")).length} call${trace.length > 1 ? "s" : ""} on Token Factory${trace.some((t) => t.modelId?.startsWith("tavily")) ? ", 1 Tavily search" : ""}`), el("span", {}, `${fmtMs(total.ms)} · ${fmtCost(total.cost)}`)),
  );
  bind("session-cost").textContent = `This session: ${fmtCost(state.session.cost)}`;
}

// ---- sending -------------------------------------------------------------------------------

function history() {
  return state.thread
    .filter((t) => (t.type === "owner" && t.text) || (t.type === "agent" && t.text))
    .slice(-6)
    .map((t) => ({ role: t.type === "owner" ? "user" : "assistant", content: t.text.slice(0, 600) }));
}

function thinking(withPhoto) {
  const stages = withPhoto
    ? ["Nemotron 3.5 Super VL is reading the photo…", "Nemotron 3 Nano is matching it to your stock…", "Checking the double entry…"]
    : ["Nemotron 3 Nano is reading your message…", "Checking the double entry…"];
  const label = el("span", {}, stages[0]);
  const li = el("li", { class: "msg msg-agent" }, el("div", { class: "thinking" }, el("span", { class: "pulse", "aria-hidden": "true" }, el("i"), el("i"), el("i")), label));
  let i = 0;
  const timer = setInterval(() => {
    i = Math.min(i + 1, stages.length - 1);
    label.textContent = stages[i];
  }, withPhoto ? 2600 : 1800);
  return { li, stop: () => clearInterval(timer) };
}

async function send(text, image) {
  if (busy) return;
  text = (text || "").trim();
  if (!text && !image) return;
  busy = true;
  $(".send").disabled = true;
  const thread = $(".thread");
  const histBefore = history();
  const ownerItem = { id: `o${Date.now()}`, type: "owner", text, image: image ? await thumb(image) : undefined };
  state.thread.push(ownerItem);
  thread.append(renderItem(ownerItem));
  const wait = thinking(Boolean(image));
  thread.append(wait.li);
  thread.scrollTop = thread.scrollHeight;
  try {
    const res = await fetch("api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, image, books: state.books, history: histBefore, now: nowLocal(state.books.today) }),
    });
    const data = await res.json().catch(() => ({}));
    wait.stop();
    wait.li.remove();
    if (!res.ok) throw new Error(data.error || "The agent did not answer. Try again.");
    const item = { id: `a${Date.now()}`, type: "agent", text: data.reply, proposals: data.proposals || [], trace: data.trace || [], escalated: data.escalated };
    for (const t of item.trace) {
      state.session.cost += t.cost;
      state.session.calls += 1;
    }
    state.thread.push(item);
    thread.append(renderItem(item));
    renderRoute(item.trace);
  } catch (err) {
    wait.stop();
    wait.li.remove();
    const item = { id: `e${Date.now()}`, type: "error", text: err.message || "Something went wrong. Try again." };
    state.thread.push(item);
    thread.append(renderItem(item));
  } finally {
    save();
    busy = false;
    $(".send").disabled = false;
    thread.scrollTop = thread.scrollHeight;
  }
}

function thumb(dataUrl) {
  return shrink(dataUrl, 480, 0.7);
}

function shrink(src, max, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("That file could not be read as a picture."));
    img.src = src;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("That file could not be read."));
    r.readAsDataURL(file);
  });
}

function setPhoto(dataUrl) {
  pendingPhoto = dataUrl;
  const box = $(".attached");
  box.hidden = !dataUrl;
  if (dataUrl) $('[data-role="thumb"]').src = dataUrl;
}

function resetDemo() {
  const before = state.books;
  state = fresh();
  save();
  renderThread();
  renderBooks(before);
  bind("route").replaceChildren(el("li", { class: "route-empty" }, "Send a message to see which Nemotron model handles each step, how long it took and what it cost on Token Factory."));
  bind("session-cost").textContent = "This session: $0.0000";
  toast("The demo shop is back to the start of the day.");
}

// ---- wiring --------------------------------------------------------------------------------

function wire() {
  const form = $(".composer");
  const text = $('[data-role="text"]');
  const grow = () => {
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, 120)}px`;
  };
  text.addEventListener("input", grow);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = text.value;
    const photo = pendingPhoto;
    text.value = "";
    grow();
    setPhoto(null);
    send(msg, photo);
  });

  $('[data-role="photo"]').addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPhoto(await shrink(await fileToDataUrl(file), 1600, 0.85));
      text.focus();
    } catch (err) {
      toast(err.message);
    }
  });
  $('[data-action="drop-photo"]').addEventListener("click", () => setPhoto(null));

  const chips = $(".suggest");
  chips.replaceChildren(
    ...SAMPLE_MESSAGES.map((m) =>
      el("button", {
        type: "button",
        onclick: async () => {
          if (busy) return;
          let image;
          if (m.photo) {
            const blob = await (await fetch(m.photo)).blob();
            image = await shrink(await fileToDataUrl(blob), 1600, 0.85);
          }
          send(m.text, image);
        },
      }, m.label),
    ),
  );

  document.querySelectorAll('[data-action="reset"]').forEach((b) =>
    b.addEventListener("click", () => {
      if (window.confirm("Start the demo shop's day again? This clears the chat and the books in this browser.")) resetDemo();
    }),
  );

  const ws = $(".workspace");
  ws.dataset.tab = "chat";
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      ws.dataset.tab = b.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    }),
  );

  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('[data-action="mic"]');
  if (Speech) {
    mic.hidden = false;
    let rec = null;
    mic.addEventListener("click", () => {
      if (rec) return rec.stop();
      rec = new Speech();
      rec.lang = navigator.language || "en-ZA";
      rec.interimResults = true;
      mic.classList.add("listening");
      rec.onresult = (ev) => {
        text.value = Array.from(ev.results).map((r) => r[0].transcript).join(" ");
        grow();
      };
      rec.onend = () => {
        mic.classList.remove("listening");
        rec = null;
        text.focus();
      };
      rec.onerror = () => toast("Your browser could not hear that. Try typing instead.");
      rec.start();
    });
  }

  const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((n) => io.observe(n));
}

async function health() {
  const dot = bind("live-dot");
  const label = bind("live");
  try {
    const res = await fetch("api/health");
    const h = await res.json();
    dot.classList.add(h.live ? "on" : "off");
    label.textContent = h.live ? "Agent live on Nebius Token Factory" : "No Token Factory key on this copy";
  } catch {
    dot.classList.add("off");
    label.textContent = "The agent service is not reachable";
  }
}

bind("shop").textContent = state.books.shop.name;
wire();
renderThread();
renderBooks();
const lastAgent = [...state.thread].reverse().find((t) => t.type === "agent");
if (lastAgent) renderRoute(lastAgent.trace);
bind("session-cost").textContent = `This session: ${fmtCost(state.session.cost)}`;
health();
if (new URLSearchParams(location.search).has("reset")) resetDemo();
