# CLAUDE.md: Imali AI shop agent (hackathon build)

Working instructions for this repository.

## What this is

A stand-alone demo built for the Nebius x NVIDIA Global AI Hackathon (Best Apps and Agents track): a shop owner's message or photo becomes checked double-entry records, using four NVIDIA Nemotron models on Nebius Token Factory and Tavily search and extract for checked exchange rates. It is new code and holds no Imali AI product code. README.md explains it for readers; submission/devpost-text.md is the entry's text.

## Run and test

- `NEBIUS_API_KEY=... node server/index.js`, then open http://localhost:5180. Node 20 or newer, no packages. `TAVILY_API_KEY` switches on live exchange rates.
- `node --test` runs every test in `test/` with no network. Run it before each commit.
- `NEBIUS_API_KEY=... node tools/eval-live.mjs` checks 18 owner messages against the real models (`--day` runs the demo day) and writes `submission/eval-results.json`. Quote its numbers only from a run you made, with the date.
- The film: `tools/video/narrate.py` (Murf takes), `tools/video/record.cjs` (records the running app with live calls), `tools/video/compose.py` (narration, captions, loudness). Films are not committed.
- Deploy: commit, then `scripts/deploy-prod.sh` (a clean archive of HEAD to the Vercel project). Keys live in the Vercel project's environment, never in the repository.

## Rules for this code

- The models only propose. Every record is built and checked by `public/js/ledger.js` in whole cents, and the owner confirms it. Figures the agent quotes come from the ledger through a read tool.
- Keep each job on its model: Lightning routes every message, Super VL reads photos, Super answers questions and retries failed tool calls, Ultra closes the day. A change of model or role updates the README table in the same commit.
- The demo shop, people, invoice and figures are invented. Never put a real merchant, customer or figure into the demo, the tests or the film.
- No keys in code, tests, logs or commits. The server never sends a key to the browser.
- Light theme only. Imali AI's lines on the page are the company's approved wording; change them only from that source, and write Imali AI in full.
- Check the page at 1280 and 390 pixels wide after any visual change.
