// OPH Edina (Original Pancake House, 3501 W 70th St) Toast waitlist sampler.
// Drives a real Chrome via CDP: reloads the restaurant page once a minute and
// captures the app's own waitlist GraphQL response (Cloudflare blocks non-browser
// clients by TLS fingerprint, so we never issue our own API calls).
//
// Env config (all optional):
//   CHROME_PATH, PROFILE_DIR, CSV_PATH, CDP_PORT
//   WINDOW_START / WINDOW_END  sampling window, HH:MM America/Chicago (default 06:00-15:30)
//   SMOKE_MINUTES              sample for N minutes starting now, ignoring the window
//   CI_MODE=1                  wait for window start instead of exiting when early
//   GIT_COMMIT=1               commit+push the CSV every 10 minutes (CI)
//   END_CT                     hard stop, ISO date-time CT (default 2026-08-21T15:35)

import { spawn, spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const URL_PAGE = "https://toast.app/r/oph-edina";
const PORT = process.env.CDP_PORT || "9333";
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
const PROFILE = process.env.PROFILE_DIR || path.join(DIR, "chrome-profile");
const CSV = process.env.CSV_PATH || path.join(DIR, "waitlist_log.csv");
const LOCK = path.join(DIR, "collector.lock");
const LOGF = path.join(DIR, "collector.log");
const CI = !!process.env.CI_MODE;
const GIT_COMMIT = !!process.env.GIT_COMMIT;
const WINDOW_START = process.env.WINDOW_START || "06:00";
const WINDOW_END = process.env.WINDOW_END || "15:30";
const END_CT = process.env.END_CT || "2027-12-31T15:35";
const SMOKE = process.env.SMOKE_MINUTES ? parseInt(process.env.SMOKE_MINUTES, 10) : 0;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGF, line + "\n"); } catch {}
}

// ---- Central Time helpers ----
const ctFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function ctNow() {
  const p = Object.fromEntries(ctFmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`,
    hhmm: `${hour}:${p.minute}`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

// ---- single instance lock (local only) ----
if (!CI && !SMOKE) {
  try {
    const pid = parseInt(fs.readFileSync(LOCK, "utf8"), 10);
    if (pid && pid !== process.pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
      if (alive) { console.log(`collector already running (pid ${pid}), exiting`); process.exit(0); }
    }
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  const unlock = () => { try { if (fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.unlinkSync(LOCK); } catch {} };
  process.on("exit", unlock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
}

// ---- Chrome management ----
let chromePid = null;

async function cdpHttp(pathname, method = "GET") {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method, signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

function killChrome() {
  if (!chromePid) return;
  log(`killing chrome pid ${chromePid}`);
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chromePid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-chromePid, "SIGKILL"); } catch { process.kill(chromePid, "SIGKILL"); } }
  } catch {}
  chromePid = null;
}

async function ensureChrome() {
  try { await cdpHttp("/json/version"); return; } catch {}
  killChrome();
  log("spawning chrome");
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
    "--window-position=-32000,-32000", "--window-size=1280,900",
    "--disable-features=TranslateUI",
    URL_PAGE,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  chromePid = child.pid;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { await cdpHttp("/json/version"); log(`chrome up (pid ${chromePid})`); return; } catch {}
  }
  throw new Error("chrome did not come up on CDP port");
}

async function ensureTab() {
  let targets = await cdpHttp("/json");
  let page = targets.find(t => t.type === "page" && t.url.includes("toast.app"));
  if (!page) {
    try { await cdpHttp(`/json/new?${encodeURIComponent(URL_PAGE)}`, "PUT"); } catch {}
    await sleep(2000);
    targets = await cdpHttp("/json");
    page = targets.find(t => t.type === "page" && t.url.includes("toast.app"));
  }
  if (!page) throw new Error("no toast.app tab");
  return page;
}

// ---- CDP session ----
let ws = null, wsTargetId = null, msgId = 0;
const pending = new Map();
let events = [];

async function ensureWs() {
  const page = await ensureTab();
  if (ws && ws.readyState === 1 && wsTargetId === page.id) return;
  try { ws?.close(); } catch {}
  ws = new WebSocket(page.webSocketDebuggerUrl);
  wsTargetId = page.id;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("ws connect timeout")), 10000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = e => { clearTimeout(t); rej(new Error("ws error")); };
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  ws.onclose = () => { ws = null; };
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== 1) return rej(new Error("ws not open"));
    const id = ++msgId;
    pending.set(id, res);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 15000);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- sampling ----
async function sampleOnce() {
  await ensureChrome();
  await ensureWs();
  events = [];
  await send("Page.reload", { ignoreCache: false });

  // wait for the app's waitlist GraphQL response
  const deadline = Date.now() + 40000;
  let req = null, resp = null;
  while (Date.now() < deadline && !resp) {
    await sleep(500);
    for (const e of events) {
      if (!req && e.method === "Network.requestWillBeSent" &&
          e.params.request.url.includes("do-federated-gateway") &&
          (e.params.request.postData || "").includes("WaitListEstimate")) req = e.params;
      if (req && e.method === "Network.loadingFinished" && e.params.requestId === req.requestId) resp = e.params;
      if (req && e.method === "Network.loadingFailed" && e.params.requestId === req.requestId) throw new Error("waitlist request failed to load");
    }
  }
  if (resp) {
    const body = await send("Network.getResponseBody", { requestId: req.requestId });
    const json = JSON.parse(body.result?.body || "{}");
    const est = json?.data?.booking?.publicWaitlistEstimate;
    let partySize = "";
    try { partySize = JSON.parse(req.request.postData).variables.input.partySize; } catch {}
    if (est && est.__typename === "BookingPublicWaitlistEstimateResponseSuccess") {
      return {
        status: est.status ?? "", parties: est.totalPartiesAhead ?? "",
        min: est.firstAvailability?.minMinutes ?? "", max: est.firstAvailability?.maxMinutes ?? "",
        partySize, source: "api", note: "",
      };
    }
    return { status: "ERROR", parties: "", min: "", max: "", partySize, source: "api", note: est?.__typename || "no-estimate-payload" };
  }

  // fallback: parse rendered text
  const r = await send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
  const text = r.result?.result?.value || "";
  if (/no wait, come on in/i.test(text))
    return { status: "OPEN", parties: 0, min: 0, max: 0, partySize: "", source: "dom", note: "" };
  if (/waitlist closed/i.test(text))
    return { status: "CLOSED", parties: "", min: "", max: "", partySize: "", source: "dom", note: "" };
  const m = text.match(/est\.?\s*wait:?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*min/i);
  if (m) {
    const pm = text.match(/parties waiting\s*\n?\s*(\d+)/i) || text.match(/(\d+)\s*\n?\s*parties waiting/i);
    return { status: "OPEN", parties: pm ? parseInt(pm[1], 10) : "", min: parseInt(m[1], 10), max: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10), partySize: "", source: "dom", note: "" };
  }
  if (/just a moment/i.test(text)) throw new Error("cloudflare challenge page");
  // Page rendered but no waitlist module: Toast hides it entirely outside service hours.
  if (/original pancake house/i.test(text))
    return { status: "NO_MODULE", parties: "", min: "", max: "", partySize: "", source: "dom", note: "waitlist module absent" };
  throw new Error("no waitlist data in response or DOM");
}

// ---- CSV ----
function writeRow(row) {
  const header = "ts_ct,ts_utc,waitlist_status,parties_ahead,wait_min_minutes,wait_max_minutes,party_size,source,note\n";
  if (!fs.existsSync(CSV)) {
    fs.mkdirSync(path.dirname(CSV), { recursive: true });
    fs.writeFileSync(CSV, header);
  }
  const vals = [row.ts_ct, row.ts_utc, row.status, row.parties, row.min, row.max, row.partySize, row.source, String(row.note).replace(/[,\r\n]+/g, ";")];
  fs.appendFileSync(CSV, vals.join(",") + "\n");
}

let lastCommit = 0;
function maybeCommit(force = false) {
  if (!GIT_COMMIT) return;
  if (!force && Date.now() - lastCommit < 10 * 60 * 1000) return;
  lastCommit = Date.now();
  try {
    execSync(`git add "${CSV}"`, { cwd: DIR, stdio: "ignore" });
    try { if (fs.existsSync(LOGF)) execSync(`git add "${LOGF}"`, { cwd: DIR, stdio: "ignore" }); } catch {}
    execSync(`git commit -m "waitlist samples ${new Date().toISOString()}"`, { cwd: DIR, stdio: "ignore" });
    try { execSync("git push", { cwd: DIR, stdio: "ignore" }); }
    catch { execSync("git pull --rebase && git push", { cwd: DIR, stdio: "ignore", shell: true }); }
    log("committed+pushed data");
  } catch (e) { log(`git commit skipped: ${e.message.split("\n")[0]}`); }
}

// ---- main loop ----
let windowStart = WINDOW_START, windowEnd = WINDOW_END;
if (SMOKE) {
  const now = ctNow();
  windowStart = "00:00";
  const end = new Date(Date.now() + SMOKE * 60000);
  const p = Object.fromEntries(ctFmt.formatToParts(end).map(x => [x.type, x.value]));
  windowEnd = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  log(`smoke mode: sampling until ${windowEnd} CT`);
}

log(`collector start pid=${process.pid} window=${windowStart}-${windowEnd} CT end=${END_CT} csv=${CSV}`);

let consecutiveFailures = 0;
while (true) {
  const ct = ctNow();
  if (ct.iso >= END_CT) { log("end date reached, done"); break; }
  if (ct.hhmm < windowStart) {
    if (CI || SMOKE) {
      log(`before window (${ct.hhmm} < ${windowStart}), waiting`);
      await sleep(30000);
      continue;
    }
    log(`before window (${ct.hhmm}), exiting (watchdog will restart)`);
    break;
  }
  if (ct.hhmm >= windowEnd) {
    log(`after window (${ct.hhmm} >= ${windowEnd}), exiting`);
    break;
  }

  const tsUtc = new Date().toISOString();
  try {
    const s = await sampleOnce();
    writeRow({ ts_ct: ct.iso, ts_utc: tsUtc, ...s });
    consecutiveFailures = 0;
    log(`sample: status=${s.status} parties=${s.parties} wait=${s.min}-${s.max}min src=${s.source}`);
  } catch (e) {
    consecutiveFailures++;
    let ctx = "";
    try { const ts = await cdpHttp("/json"); ctx = (ts.find(t => t.type === "page") || {}).url || ""; } catch {}
    writeRow({ ts_ct: ct.iso, ts_utc: tsUtc, status: "ERROR", parties: "", min: "", max: "", partySize: "", source: "none", note: `${e.message} | ${ctx}`.slice(0, 150) });
    log(`sample failed (${consecutiveFailures}): ${e.message.split("\n")[0]}`);
    if (consecutiveFailures >= 3) { killChrome(); try { ws?.close(); } catch {}; ws = null; consecutiveFailures = 0; }
  }
  maybeCommit();

  const wait = 60000 - (Date.now() % 60000);
  await sleep(wait);
}

maybeCommit(true);
killChrome();
log("collector exit");
process.exit(0);
