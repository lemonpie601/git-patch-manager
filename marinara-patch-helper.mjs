#!/usr/bin/env node
// 마리나라 패치 도우미 · 패치 관리자 1.3.0
//
// 마리나라를 이 도우미로 켜 두면, 패치 관리자의 [자동 적용]을 눌렀을 때 도우미가 마리나라를 잠깐 끄고,
// 꺼진 동안 패치를 넣은 뒤 다시 켭니다. 터미널을 다시 열 필요가 없습니다(SSH로 쓰는 서버, 호스팅 서버도 같음).
//
// 쓰는 법: 이 파일을 마리나라 엔진 폴더(packages 폴더가 있는 곳)에 두고, 평소 "pnpm start" 대신 실행합니다.
//   node marinara-patch-helper.mjs            마리나라를 켜고 지킵니다 (끄려면 Ctrl+C)
//   node marinara-patch-helper.mjs --code     연결 코드만 보여 주고 끝냅니다
//   --engine <폴더>   마리나라 엔진 폴더 (기본: 지금 폴더, 아니면 이 파일이 있는 폴더)
//   --port <번호>     마리나라 포트 (기본: .env의 PORT, 없으면 7860)
//   --data <폴더>     마리나라 data 폴더 (기본: .env의 DATA_DIR, 없으면 packages/server/data)
// 처음 실행하면 연결 코드가 나옵니다. 패치 관리자 → 실행 → 자동 적용에 한 번 넣어 주세요.
// 연결 코드를 넣은 브라우저가 보낸 작업만 실행합니다. 코드는 엔진 폴더의 .marinara-patch-helper.json에 있습니다.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "node:net";

const VERSION = "1.3.0";
const MANAGER_NAME = "패치 관리자";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (text) => console.log("[패치 도우미] " + text);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const here = dirname(fileURLToPath(import.meta.url));
const isEngine = (dir) => existsSync(join(dir, "packages", "server", "dist", "index.js"));
const engine = resolve(opt("--engine") || (isEngine(process.cwd()) ? process.cwd() : here));
const serverRoot = join(engine, "packages", "server");
if (!isEngine(engine)) {
  console.error("마리나라 엔진 폴더를 찾지 못했습니다 (packages/server/dist/index.js가 없음): " + engine);
  console.error("  이 파일을 엔진 폴더에 두거나 --engine <폴더>로 알려 주세요. 마리나라를 한 번은 빌드(설치)해야 합니다.");
  process.exit(1);
}

function readEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {}
  return out;
}
const env = { ...readEnv(process.env.MARINARA_ENV_FILE || join(engine, ".env")), ...process.env };
const port = Number(opt("--port") || env.PORT || 7860);
const dataDir = opt("--data") ? resolve(opt("--data")) : env.DATA_DIR ? resolve(serverRoot, env.DATA_DIR) : join(serverRoot, "data");
const base = "http://127.0.0.1:" + port + "/api";

const configFile = join(engine, ".marinara-patch-helper.json");
const config = (() => {
  let value = {};
  try {
    value = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {}
  if (typeof value.secret !== "string" || !/^[0-9a-f]{32}$/.test(value.secret)) value.secret = randomBytes(16).toString("hex");
  if (!Array.isArray(value.done)) value.done = [];
  return value;
})();
const saveConfig = () => writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
saveConfig();
const pairingCode = config.secret.match(/.{4}/g).join("-");
if (args.includes("--code")) {
  console.log("연결 코드: " + pairingCode);
  process.exit(0);
}

async function api(path, method = "GET", body) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["x-marinara-csrf"] = "1";
  if (body) headers["Content-Type"] = "application/json";
  if (env.ADMIN_SECRET) headers["X-Admin-Secret"] = env.ADMIN_SECRET;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.message || data.error)) || "HTTP " + res.status);
  return data;
}

let managerId = null;
async function readStorage() {
  if (!managerId) {
    const list = await api("/personal-extensions");
    const hit = Array.isArray(list) ? list.find((x) => x && x.name === MANAGER_NAME && x.enabled) : null;
    if (!hit) return null;
    managerId = hit.id;
  }
  try {
    return (await api("/personal-extensions/" + encodeURIComponent(managerId) + "/storage")).value || {};
  } catch (e) {
    managerId = null;
    throw e;
  }
}

// Written only when something happens: Marinara's storage patch is read-then-write, so frequent
// writes from here could race the manager's own saves.
let status = { version: VERSION, engine, startedAt: new Date().toISOString() };
async function report(fields) {
  status = { ...status, ...fields, at: new Date().toISOString() };
  if (managerId) await api("/personal-extensions/" + encodeURIComponent(managerId) + "/storage", "PATCH", { helper: status });
}

const safeFile = (name) => String(name || "patch.mjs").replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "") || "patch.mjs";

/** The patches a job names, checked against their recorded hashes and the job's signature. */
function verify(job, value) {
  if (!["apply", "restore"].includes(job.mode)) return "작업 형식이 올바르지 않습니다.";
  if (!(Date.now() - Date.parse(job.at) < 15 * 60 * 1000)) return "15분이 넘은 작업이라 실행하지 않았습니다. 다시 눌러 주세요.";
  const patches = Array.isArray(value.patches) ? value.patches : [];
  const scripts = value.scripts && typeof value.scripts === "object" ? value.scripts : {};
  const list = [];
  for (const id of Array.isArray(job.patchIds) ? job.patchIds : []) {
    const p = patches.find((x) => x && x.id === id);
    const code = scripts[id];
    if (!p || typeof code !== "string") return "패치를 찾지 못했습니다: " + id;
    if (sha256(code) !== p.hash) return "패치 코드가 기록과 다릅니다: " + p.name;
    list.push({ name: String(p.name), file: safeFile(p.file), restore: !!p.restore, code, hash: p.hash });
  }
  if (!list.length) return "실행할 패치가 없습니다.";
  const expected = createHmac("sha256", config.secret)
    .update([job.id, job.mode, job.at, list.map((p) => p.hash).join(",")].join("|"))
    .digest();
  const given = Buffer.from(String(job.mac || ""), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "연결 코드가 맞지 않는 작업이라 실행하지 않았습니다. 패치 관리자에 연결 코드를 다시 넣어 주세요.";
  return list;
}

// ----- 검사 · 백업본 정리 (마리나라가 켜진 채로 해도 되는 일) -----
// The same scan the manager does on a picked folder, run here on the server's own files, for servers
// the browser cannot reach as a folder (SSH, hosting). Same field names, same fingerprint.
const capDir = join(dataDir, "capability-packages");
const BACKUP_FILE = /\.[\w-]*backup$|\.bak$|\.orig$/i;
const MARKER = /\/\*([\w.-]+):(?:start|head|begin)\*\//g;

function listFiles(dir, rel, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const d of entries) {
    if (d.isDirectory()) listFiles(join(dir, d.name), rel + d.name + "/", out);
    else if (d.isFile()) out.push(rel + d.name);
  }
  return out;
}

function scanData() {
  const registry = JSON.parse(readFileSync(join(capDir, "installed.json"), "utf8"));
  const installed = (Array.isArray(registry.packages) ? registry.packages : []).filter((x) => x && typeof x.id === "string");
  const files = listFiles(join(capDir, "versions"), "versions/", []);
  const packages = installed.map((pkg) => {
    const markers = new Set();
    const base = "versions/" + pkg.id + "/" + pkg.version + "/";
    const entry = pkg.manifest && pkg.manifest.entrypoints ? pkg.manifest.entrypoints : {};
    for (const rel of [entry.server, entry.client]) {
      if (typeof rel !== "string" || !rel || !files.includes(base + rel)) continue;
      for (const m of readFileSync(join(capDir, ...(base + rel).split("/")), "utf8").matchAll(MARKER)) markers.add(m[1]);
    }
    const list = Array.isArray(pkg.manifest && pkg.manifest.files) ? pkg.manifest.files : null;
    const fingerprint = list ? sha256(JSON.stringify(list.map((f) => [String(f && f.path), String(f && f.sha256)]).sort((a, b) => a[0].localeCompare(b[0])))) : null;
    return { id: pkg.id, name: (pkg.manifest && pkg.manifest.name) || pkg.id, version: String(pkg.version ?? ""), markers: [...markers], fingerprint };
  });
  const backups = files
    .filter((p) => BACKUP_FILE.test(p))
    .slice(0, 300)
    .map((p) => {
      const st = statSync(join(capDir, ...p.split("/")));
      const [, pkgId, version] = p.split("/");
      const pkg = installed.find((x) => x.id === pkgId);
      return { path: p, size: st.size, modified: st.mtimeMs, pkgId, current: pkg ? String(pkg.version) === version : false };
    });
  return { at: new Date().toISOString(), packages, backups };
}

/** Deletes only backup files inside capability-packages/versions, whatever the job lists. */
function cleanBackups(paths) {
  let removed = 0;
  for (const rel of Array.isArray(paths) ? paths : []) {
    if (typeof rel !== "string" || !rel.startsWith("versions/") || !BACKUP_FILE.test(rel) || rel.split("/").some((x) => !x || x === "." || x === "..")) continue;
    const file = resolve(capDir, ...rel.split("/"));
    if (!file.startsWith(capDir + sep)) continue;
    try {
      if (statSync(file).isFile()) {
        rmSync(file);
        removed += 1;
        say("백업본을 지웠습니다: " + rel);
      }
    } catch {}
  }
  return removed;
}

function signed(job, payload) {
  const expected = createHmac("sha256", config.secret).update([job.id, job.kind || job.mode, job.at, payload].join("|")).digest();
  const given = Buffer.from(String(job.mac || ""), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function exited(proc) {
  return new Promise((done) => {
    proc.once("error", (error) => {
      console.error("실행하지 못했습니다: " + error.message);
      done(1);
    });
    proc.once("close", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

function runPatch(file, extra) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [file, ...extra, dataDir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk) => {
      process.stdout.write(chunk);
      out += chunk;
    };
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    exited(proc).then((code) => done({ code, out: out.trim() }));
  });
}

let pending = null;
let unsent = null;

// Marinara is fully down when this runs: its process closed after a graceful restart.
async function runJob({ job, list }) {
  const restore = job.mode === "restore";
  const order = restore ? list.filter((p) => p.restore).reverse() : list;
  say((restore ? "되돌리기" : "적용") + " · 패치 " + order.length + "개 (마리나라가 꺼진 동안)");
  const dir = mkdtempSync(join(tmpdir(), "marinara-patch-helper-"));
  const items = [];
  let log = "";
  try {
    for (const [i, p] of order.entries()) {
      const sub = join(dir, String(i));
      mkdirSync(sub);
      const file = join(sub, p.file);
      writeFileSync(file, p.code);
      say("[" + (i + 1) + "/" + order.length + "] " + p.name);
      const r = await runPatch(file, restore ? ["--restore"] : []);
      log += "▶ " + p.name + "\n" + r.out + "\n\n";
      items.push({ name: p.name, ok: r.code === 0 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = items.every((x) => x.ok);
  say(ok ? "패치를 마쳤습니다. 마리나라를 다시 켭니다." : "실패한 패치가 있습니다. 마리나라를 다시 켭니다.");
  unsent = { doneJob: job.id, error: null, result: { ok, at: new Date().toISOString(), mode: job.mode, items, log: log.slice(-6000) } };
}

let child = null;
let stopping = false;

async function watch() {
  let seen = null;
  for (;;) {
    await sleep(3000);
    if (stopping) return;
    if (!child || pending) continue;
    let value;
    try {
      value = await readStorage();
    } catch {
      continue;
    }
    if (!value) continue;
    try {
      if (unsent) {
        await report(unsent);
        unsent = null;
      } else if (!status.reported) {
        await report({ reported: true });
      }
    } catch {}
    const job = value.helperJob;
    if (!job || typeof job.id !== "string" || job.id === seen || config.done.includes(job.id)) continue;
    seen = job.id;
    if (job.kind === "scan" || job.kind === "clean") {
      config.done = [...config.done, job.id].slice(-50);
      saveConfig();
      const paths = job.kind === "clean" && Array.isArray(job.paths) ? job.paths.map(String) : [];
      let fields;
      if (!(Date.now() - Date.parse(job.at) < 15 * 60 * 1000)) fields = { error: "15분이 넘은 작업이라 실행하지 않았습니다." };
      else if (!signed(job, paths.join(","))) fields = { error: "연결 코드가 맞지 않는 작업이라 실행하지 않았습니다. 패치 관리자에 연결 코드를 다시 넣어 주세요." };
      else {
        try {
          const removed = job.kind === "clean" ? cleanBackups(paths) : 0;
          fields = { error: null, scan: { ...scanData(), jobId: job.id, removed } };
          if (job.kind === "scan") say("data 폴더를 검사했습니다.");
        } catch (e) {
          fields = { error: "검사하지 못했습니다: " + e.message };
        }
      }
      if (fields.error) say("작업을 처리하지 못했습니다: " + fields.error);
      await report({ seenJob: job.id, doneJob: job.id, ...fields }).catch(() => {});
      continue;
    }
    const list = verify(job, value);
    config.done = [...config.done, job.id].slice(-50);
    saveConfig();
    if (typeof list === "string") {
      say("작업을 거절했습니다: " + list);
      await report({ seenJob: job.id, doneJob: job.id, error: list, result: { ok: false, at: new Date().toISOString(), mode: job.mode, items: [], log: list } }).catch(() => {});
      continue;
    }
    say("패치 작업을 받았습니다 (" + list.length + "개). 마리나라를 재시작합니다.");
    pending = { job, list };
    try {
      await report({ seenJob: job.id, error: null });
      await api("/admin/restart", "POST", { confirm: true });
    } catch (e) {
      pending = null;
      say("재시작하지 못했습니다: " + e.message);
      await report({ doneJob: job.id, error: "재시작하지 못했습니다: " + e.message }).catch(() => {});
    }
  }
}

async function rebuildIfNeeded() {
  let changed = null;
  try {
    const meta = await import(pathToFileURL(join(serverRoot, "scripts", "write-build-meta.mjs")).href);
    changed = typeof meta.findChangedBuildFile === "function" ? meta.findChangedBuildFile() : null;
  } catch {
    return true;
  }
  if (!changed) return true;
  say("빌드한 뒤 바뀐 서버 파일이 있어 다시 빌드합니다: dist/" + changed);
  return (await exited(spawn(process.execPath, [join(serverRoot, "scripts", "build.mjs")], { cwd: serverRoot, stdio: "inherit" }))) === 0;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    // Windows already hands console Ctrl+C to the server; forwarding would kill it before it saves.
    if (process.platform !== "win32") child?.kill(signal);
    setTimeout(() => child?.kill("SIGKILL"), 10000).unref();
  });
}

// A Marinara started some other way already holds the port and the data folder; a second server would fail,
// and only a Marinara this helper started can be restarted by it.
const portBusy = await new Promise((done) => {
  const socket = connect({ host: "127.0.0.1", port });
  const finish = (value) => {
    socket.destroy();
    done(value);
  };
  socket.setTimeout(800, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});
if (portBusy) {
  console.error("[패치 도우미] 마리나라가 이미 켜져 있습니다 (포트 " + port + ").");
  console.error("  런처나 다른 창으로 켠 마리나라를 먼저 끈 뒤, 이 도우미로 다시 켜 주세요. 도우미가 직접 켠 마리나라만 자동 적용할 수 있습니다.");
  process.exit(1);
}
say("마리나라 엔진: " + engine);
say("data 폴더: " + dataDir);
say("연결 코드: " + pairingCode + "  ← 패치 관리자 → 실행 → 자동 적용에 한 번 넣어 주세요");
void watch();
for (;;) {
  if (!(await rebuildIfNeeded())) {
    process.exitCode = 1;
    break;
  }
  // Marinara allows its graceful restart only when this env names its parent: that is what makes
  // this helper the supervisor that gets the restart's gap.
  child = spawn(process.execPath, [join(serverRoot, "dist", "index.js")], {
    cwd: engine,
    stdio: "inherit",
    env: { ...process.env, MARINARA_RESTART_SUPERVISOR: String(process.pid) },
  });
  const code = await exited(child);
  child = null;
  if (stopping || code !== 75) {
    if (pending) say("마리나라가 재시작이 아닌 이유로 꺼져 패치하지 않았습니다.");
    process.exitCode = stopping ? 0 : code;
    break;
  }
  if (pending) {
    const job = pending;
    try {
      await runJob(job);
    } catch (e) {
      unsent = { doneJob: job.job.id, error: e.message, result: { ok: false, at: new Date().toISOString(), mode: job.job.mode, items: [], log: e.message } };
    }
    pending = null;
  }
}
process.exit(process.exitCode ?? 0);
