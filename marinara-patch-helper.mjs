#!/usr/bin/env node
// 마리나라 패치 도우미 · 패치 관리자 1.4.1
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
import { join, resolve, dirname, sep, relative, isAbsolute, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "node:net";

const VERSION = "1.4.1";
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
// The server gets the environment start.bat / start.sh give it: .env loaded before Node starts (so settings
// such as NODE_OPTIONS --require add-ons take effect), then the launchers' own defaults. Only the server gets
// it; patch scripts run with this helper's plain environment, without those add-ons preloaded.
// Read again at every start: turning a runtime patch on or off rewrites NODE_OPTIONS in .env.
const envFile = process.env.MARINARA_ENV_FILE || join(engine, ".env");
function launchEnv() {
  const fileEnv = {};
  for (const [key, value] of Object.entries(readEnv(envFile))) if (value !== "") fileEnv[key] = value;
  const out = { ...process.env, ...fileEnv };
  if (opt("--port")) out.PORT = opt("--port");
  out.NODE_ENV = "production";
  out.PORT = out.PORT || "7860";
  out.HOST = out.HOST || "0.0.0.0";
  out.SIDECAR_RUNTIME_INSTALL_ENABLED = out.SIDECAR_RUNTIME_INSTALL_ENABLED || "true";
  return out;
}
const env = launchEnv();
const port = Number(env.PORT) || 7860;
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
let attached = false;
let status = { version: VERSION, engine, startedAt: new Date().toISOString() };
async function report(fields) {
  status = { ...status, ...fields, supervisor: !attached, at: new Date().toISOString() };
  if (!managerId) return;
  const path = "/personal-extensions/" + encodeURIComponent(managerId) + "/storage";
  // The storage patch is read-then-write on the server, so a save from the page at the same moment can
  // undo this one. Read it back and write again until it holds.
  for (let i = 0; i < 4; i++) {
    await api(path, "PATCH", { helper: status });
    await sleep(500 + i * 500);
    const back = await api(path).catch(() => null);
    if (back && back.value && back.value.helper && back.value.helper.at === status.at) return;
  }
  throw new Error("패치 관리자에 답을 저장하지 못했습니다.");
}
const ATTACHED_ONLY = "이 마리나라는 도우미가 켠 것이 아니라서(런처·서비스 등으로 켬) 도우미가 재시작하며 패치할 수 없습니다. 설치된 패치 찾기와 백업본 정리는 됩니다. 자동 적용을 쓰려면 마리나라를 끄고 'node marinara-patch-helper.mjs'로 켜 주세요. 런타임 패치만 바꾸는 거라면 화면의 NODE_OPTIONS 줄을 .env에 넣고 평소처럼 다시 켜도 됩니다.";

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

// ----- 설치된 패치 찾기 -----
// Two kinds of patch live on a Marinara install:
//   runtime patches: .cjs files loaded with NODE_OPTIONS --require (from .env); they change code in memory
//                    as it loads and never touch files, so .env is where they are switched on, off and ordered;
//   file patches:    scripts like patch/apply-patch.mjs that rewrite package files (found by their markers).
// Marinara's own folders are skipped: patches/ there is pnpm's, custom_components is Home Assistant's.
const OWN_DIRS = new Set(["node_modules", "packages", "patches", "android", "docs", "e2e", "scripts", "tools", "win", "custom_components"]);
const PATCH_FILE = /(^|\/)(patch|patches)\/[^/]+\.(mjs|cjs|js)$|(^|\/)[^/]*patch[^/]*\.(mjs|cjs)$/i;
const KEEP_TAGS = /^(json|js|cjs|mjs|ts|md|txt|zip|example|map|lock|yaml|yml)$/i;
const toSlash = (p) => p.split(sep).join("/");
const relEngine = (abs) => {
  const r = relative(engine, abs);
  return r && !r.startsWith("..") && !isAbsolute(r) ? toSlash(r) : null;
};

function nodeOptionsOf(value) {
  const tokens = String(value || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const requires = [];
  const other = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = /^(?:--require|-r)=(.*)$/.exec(t);
    let v = m ? m[1] : null;
    if (v === null && (t === "--require" || t === "-r") && i + 1 < tokens.length) v = tokens[++i];
    if (v === null) other.push(t);
    else requires.push(v.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return { requires, other };
}
const requirePath = (v) => resolve(serverRoot, v);

function describe(text, file) {
  const body = text.replace(/\r\n?/g, "\n").replace(/^#!.*\n/, "").replace(/^\s*(['"])use strict\1;?[ \t]*\n/, "");
  const block = /^\s*\/\*+([\s\S]*?)\*\//.exec(body);
  const lines = block
    ? block[1].split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd())
    : (/^(?:[ \t]*\/\/.*\n?)+/.exec(body)?.[0] || "").split("\n").map((l) => l.replace(/^\s*\/\/\s?/, "").trimEnd());
  const description = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
  const name = basename(file).replace(/\.(cjs|mjs|js)$/i, "").replace(/[-_.]runtime$/i, "");
  return { name, description };
}

/** Which installed packages (and versions) a patch names: "gacha-forge-1\.8\.13", "Gacha Forge 1.8.13". */
function targetsOf(text, installed) {
  const t = text.replace(/\\\./g, ".");
  const escRe = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const out = [];
  for (const pkg of installed) {
    const name = (pkg.manifest && pkg.manifest.name) || pkg.id;
    const re = new RegExp("(?:" + escRe(pkg.id) + "[-@ ]|" + escRe(name).replace(/\s+/g, "\\s+") + "\\s+v?)(\\d+\\.\\d+\\.\\d+)", "gi");
    const wants = [...new Set(Array.from(t.matchAll(re), (m) => m[1]))];
    if (wants.length) out.push({ id: pkg.id, name, wants, installed: String(pkg.version) });
  }
  return out;
}

/** Settings a runtime patch reads: paths in .env it uses through process.env, and JSON next to it. */
function configsOf(text, file, envValues) {
  const found = new Map();
  for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    const v = envValues[m[1]];
    if (v && /\.(json|ya?ml|txt)$/i.test(v)) found.set(resolve(serverRoot, v), m[1]);
  }
  for (const m of text.matchAll(/join\(\s*__dirname\s*,\s*['"]([^'"]+\.json)['"]\s*\)/g)) found.set(join(dirname(file), m[1]), "같은 폴더");
  // A JSON named after the patch itself (gacha-npc-portrait-runtime.cjs → gacha-npc-portrait.json).
  const stem = basename(file).replace(/\.(cjs|mjs|js)$/i, "").replace(/[-_.]runtime$/i, "").toLowerCase();
  for (const m of text.matchAll(/['"]([\w.-]+\.json)['"]/g)) {
    const p = join(dirname(file), m[1]);
    if (!found.has(p) && m[1].toLowerCase().startsWith(stem) && existsSync(p)) found.set(p, "같은 폴더");
  }
  // package.json and friends are how a patch finds Node modules, not settings of its own.
  return [...found]
    .filter(([p]) => !/^(package(-lock)?|tsconfig[\w.-]*|pnpm-[\w.-]+)\.json$/i.test(basename(p)))
    .map(([p, via]) => ({ via, path: relEngine(p) || toSlash(p), exists: existsSync(p) }));
}

function fileSize(abs) {
  const st = statSync(abs);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const rel of listFiles(abs, "", [])) {
    try {
      total += statSync(join(abs, rel)).size;
    } catch {}
  }
  return total;
}

/** Old copies that installs left: .env.before-*, name.json.bak / .gf1812 / .before-x beside the real file, .prev/.backup-* folders. */
function engineBackups(runtimeFiles) {
  const out = new Map();
  const add = (abs, group) => {
    const rel = relEngine(abs);
    if (!rel || out.has(rel)) return;
    try {
      const st = statSync(abs);
      out.set(rel, { path: "engine/" + rel, size: fileSize(abs), modified: st.mtimeMs, scope: "engine", group, dir: st.isDirectory() });
    } catch {}
  };
  for (const d of readdirSync(engine, { withFileTypes: true })) if (d.isFile() && /^\.env\./.test(d.name) && d.name !== ".env.example") add(join(engine, d.name), ".env 사본");
  const folders = new Map();
  for (const f of runtimeFiles) {
    const dir = dirname(f);
    if (dir === engine) {
      for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isFile() && d.name.startsWith(basename(f) + ".")) add(join(dir, d.name), basename(f));
    } else if (relEngine(dir)) folders.set(dir, relEngine(dir));
  }
  for (const [dir, label] of folders) {
    const names = readdirSync(dir, { withFileTypes: true });
    const files = new Set(names.filter((d) => d.isFile()).map((d) => d.name));
    for (const d of names) {
      if (d.isDirectory() && (d.name === ".prev" || /^\.?backup/i.test(d.name) || /^\.old/i.test(d.name))) add(join(dir, d.name), label);
      if (!d.isFile()) continue;
      const cut = d.name.lastIndexOf(".");
      const base = d.name.slice(0, cut);
      const tag = d.name.slice(cut + 1);
      if (BACKUP_FILE.test(d.name) || (cut > 0 && files.has(base) && !KEEP_TAGS.test(tag))) add(join(dir, d.name), label);
    }
  }
  return [...out.values()];
}

function findScripts(skip) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const d of entries) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < 4 && !d.name.startsWith(".") && d.name !== "node_modules" && !(depth === 0 && OWN_DIRS.has(d.name))) walk(abs, rel + d.name + "/", depth + 1);
      } else if (d.isFile() && depth > 0 && PATCH_FILE.test(rel + d.name) && !skip.has(abs) && out.length < 30) {
        const st = statSync(abs);
        if (st.size <= 2 * 1024 * 1024) out.push({ path: rel + d.name, size: st.size, code: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(engine, "", 0);
  return out;
}

function discover() {
  const scan = scanData();
  const registry = JSON.parse(readFileSync(join(capDir, "installed.json"), "utf8"));
  const installed = (Array.isArray(registry.packages) ? registry.packages : []).filter((x) => x && typeof x.id === "string");
  const envValues = readEnv(envFile);
  const opts = nodeOptionsOf(envValues.NODE_OPTIONS);
  const runtime = opts.requires.map((value, order) => {
    const abs = requirePath(value);
    const rel = relEngine(abs);
    const item = { value, path: rel || toSlash(abs), inEngine: !!rel, order, exists: existsSync(abs) };
    if (!item.exists) return item;
    const text = readFileSync(abs, "utf8");
    return { ...item, size: statSync(abs).size, sha256: sha256(text), ...describe(text, abs), targets: targetsOf(text, installed), configs: configsOf(text, abs, envValues) };
  });
  const runtimeFiles = runtime.filter((r) => r.exists).map((r) => requirePath(r.value));
  for (const b of scan.backups) b.scope = "package";
  return {
    ...scan,
    backups: [...scan.backups, ...engineBackups(runtimeFiles)],
    runtime,
    nodeOptionsOther: opts.other,
    scripts: findScripts(new Set(runtimeFiles)),
  };
}

/** Deletes only what a fresh look still lists as a backup, whatever the job names. */
function cleanBackups(paths) {
  const allowed = new Map(discover().backups.map((b) => [b.path, b]));
  let removed = 0;
  for (const p of Array.isArray(paths) ? paths : []) {
    const b = allowed.get(p);
    if (!b) continue;
    const abs = b.scope === "engine" ? resolve(engine, ...p.slice("engine/".length).split("/")) : resolve(capDir, ...p.split("/"));
    if (!relEngine(abs) && !abs.startsWith(capDir + sep)) continue;
    try {
      rmSync(abs, { recursive: !!b.dir, force: true });
      removed += 1;
      say("백업본을 지웠습니다: " + p);
    } catch {}
  }
  return removed;
}

/** NODE_OPTIONS with the engine's runtime patches set to the list given, everything else kept as it was. */
function nextNodeOptions(rels) {
  const current = nodeOptionsOf(readEnv(envFile).NODE_OPTIONS);
  const outside = current.requires.filter((v) => !relEngine(requirePath(v)));
  const quote = (p) => (/\s/.test(p) ? '"' + p + '"' : p);
  const keep = [...current.other, ...outside.map((v) => "--require=" + quote(v))];
  const wanted = rels.map((rel) => "--require=" + quote(toSlash(resolve(engine, ...rel.split("/")))));
  return [...keep, ...wanted].join(" ");
}

function writeNodeOptions(value) {
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  writeFileSync(envFile + ".patch-manager-backup", text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*(?:export\s+)?NODE_OPTIONS\s*=/.test(l));
  const line = "NODE_OPTIONS=" + value;
  if (at >= 0) lines[at] = line;
  else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, line);
  writeFileSync(envFile, lines.join(eol));
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
  // Say once how the link to the manager stands, so a silent helper can be told apart from a missing one.
  let link = "";
  const linkState = (state, text) => {
    if (state !== link) say(text);
    link = state;
  };
  const startedAt = Date.now();
  for (;;) {
    await sleep(3000);
    if (stopping) return;
    if ((!child && !attached) || pending) continue;
    let value;
    try {
      value = await readStorage();
    } catch (e) {
      // The server takes a while to come up; only complain once it should have.
      if (Date.now() - startedAt > 60000) linkState("error:" + e.message, "패치 관리자에 연결하지 못했습니다: " + e.message);
      continue;
    }
    if (!value) {
      linkState("missing", "\"" + MANAGER_NAME + "\" 확장을 찾지 못했습니다. 외부 확장에서 켜져(승인되어) 있는지 확인해 주세요. 찾으면 바로 연결합니다.");
      continue;
    }
    linkState("ok", "패치 관리자와 연결했습니다. 이제 [검사] → [설치된 패치 찾기 (도우미)]와 [자동 적용]을 쓸 수 있습니다.");
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
          fields = { error: null, scan: { ...discover(), jobId: job.id, removed } };
          if (job.kind === "scan") say("설치된 패치를 찾았습니다.");
        } catch (e) {
          fields = { error: "검사하지 못했습니다: " + e.message };
        }
      }
      if (fields.error) say("작업을 처리하지 못했습니다: " + fields.error);
      await report({ seenJob: job.id, doneJob: job.id, ...fields }).catch(() => {});
      continue;
    }
    if (job.kind === "runtime") {
      config.done = [...config.done, job.id].slice(-50);
      saveConfig();
      const rels = Array.isArray(job.requires) ? job.requires.map(String) : [];
      let problem = "";
      if (!(Date.now() - Date.parse(job.at) < 15 * 60 * 1000)) problem = "15분이 넘은 작업이라 실행하지 않았습니다.";
      else if (!signed(job, rels.join(","))) problem = "연결 코드가 맞지 않는 작업이라 실행하지 않았습니다. 패치 관리자에 연결 코드를 다시 넣어 주세요.";
      else {
        for (const rel of rels) {
          const abs = resolve(engine, ...rel.split("/"));
          if (rel.split("/").some((x) => !x || x === "." || x === "..") || !relEngine(abs) || !/\.(c?js|mjs)$/i.test(rel) || !existsSync(abs)) problem = "켤 수 없는 파일입니다: " + rel;
        }
      }
      if (!problem && attached) problem = ATTACHED_ONLY;
      if (problem) {
        say("작업을 거절했습니다: " + problem);
        await report({ seenJob: job.id, doneJob: job.id, error: problem }).catch(() => {});
        continue;
      }
      say("런타임 패치 설정을 받았습니다 (켜짐 " + rels.length + "개). 마리나라를 재시작합니다.");
      pending = { job, nodeOptions: nextNodeOptions(rels) };
      try {
        await report({ seenJob: job.id, error: null });
        await api("/admin/restart", "POST", { confirm: true });
      } catch (e) {
        pending = null;
        say("재시작하지 못했습니다: " + e.message);
        await report({ doneJob: job.id, error: "재시작하지 못했습니다: " + e.message }).catch(() => {});
      }
      continue;
    }
    const list = attached ? ATTACHED_ONLY : verify(job, value);
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

// Look only: what the manager would see, without starting Marinara.
if (args.includes("--discover")) {
  const d = discover();
  if (args.includes("--json")) {
    console.log(JSON.stringify(d));
    process.exit(0);
  }
  console.log("런타임 패치 (NODE_OPTIONS 순서):");
  for (const r of d.runtime) {
    const t = (r.targets || []).map((x) => x.name + " " + x.wants.join("/") + (x.wants.includes(x.installed) ? "" : " ≠ 설치 " + x.installed)).join(", ");
    console.log("  " + (r.order + 1) + ". " + (r.name || r.path) + (r.exists ? "" : " [파일 없음]") + "  " + r.path + (t ? "  · 대상 " + t : "") + ((r.configs || []).length ? "  · 설정 " + r.configs.map((c) => c.path).join(", ") : ""));
  }
  console.log("파일 패치 스크립트:");
  for (const s of d.scripts) console.log("  " + s.path);
  console.log("패키지 속 패치 표식:");
  for (const p of d.packages.filter((x) => x.markers.length)) console.log("  " + p.id + " " + p.version + ": " + p.markers.join(", "));
  console.log("백업본:");
  for (const b of d.backups) console.log("  " + b.path + (b.dir ? "/" : "") + "  (" + Math.round(b.size / 1024) + "KB)");
  process.exit(0);
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
say("마리나라 엔진: " + engine);
say("data 폴더: " + dataDir);
say("연결 코드: " + pairingCode + "  ← 패치 관리자 → 실행 → 자동 적용에 한 번 넣어 주세요");
// Marinara already running (launcher, watchdog, a service): stay beside it instead of starting another.
// Finding patches and cleaning backups need no restart, so those still work.
if (portBusy) {
  attached = true;
  say("마리나라가 이미 켜져 있어(포트 " + port + ") 옆에 붙어서 돕니다. 이 창은 켜 둔 채로 두세요(끝내려면 Ctrl+C).");
  say("  지금 되는 것: 설치된 패치 찾기, 백업본 정리.");
  say("  재시작이 필요한 것(자동 적용, 런타임 패치 켜기·끄기)은 마리나라를 끄고 이 도우미로 켜야 합니다.");
  await watch();
  process.exit(0);
}
void watch();
for (;;) {
  if (!(await rebuildIfNeeded())) {
    process.exitCode = 1;
    break;
  }
  // Marinara allows its graceful restart only when this env names its parent: that is what makes
  // this helper the supervisor that gets the restart's gap.
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: serverRoot,
    stdio: "inherit",
    env: { ...launchEnv(), MARINARA_RESTART_SUPERVISOR: String(process.pid) },
  });
  const code = await exited(child);
  child = null;
  if (stopping || code !== 75) {
    if (pending) say("마리나라가 재시작이 아닌 이유로 꺼져 패치하지 않았습니다.");
    process.exitCode = stopping ? 0 : code;
    break;
  }
  if (pending && pending.nodeOptions !== undefined) {
    // Runtime patches: .env is read at the next start, so this is the whole change.
    const job = pending.job;
    try {
      writeNodeOptions(pending.nodeOptions);
      say("NODE_OPTIONS를 바꿨습니다 (이전 .env는 .env.patch-manager-backup). 마리나라를 다시 켭니다.");
      unsent = { doneJob: job.id, error: null, result: { ok: true, at: new Date().toISOString(), mode: "runtime", items: [], log: "NODE_OPTIONS=" + pending.nodeOptions }, scan: { ...discover(), jobId: job.id } };
    } catch (e) {
      unsent = { doneJob: job.id, error: "NODE_OPTIONS를 바꾸지 못했습니다: " + e.message };
    }
    pending = null;
  } else if (pending) {
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
