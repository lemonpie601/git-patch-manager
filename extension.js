// 패치 관리자 · GitHub 확장 관리자 1.1.4-G를 바탕으로 만든 서버 패치 관리자.
//
// "패치"는 마리나라 설치 패키지(가챠 포지 등)의 파일을 고치는 Node 스크립트입니다(patch/apply-patch.mjs 같은 것).
// 브라우저 확장은 서버 파일에 손댈 수 없으므로, 이 관리자는 패치를 모으고(GitHub · 파일) 업데이트를 확인하고,
// 켜 둔 패치를 한 번에 돌리는 실행 파일(marinara-patches.mjs)을 만들어 줍니다. 실제 적용은 마리나라를 끈 뒤
// 사용자가 node로 실행합니다. 마리나라를 다시 켜면 설치 기록(/api/capability-packages/installed)의 파일 해시를
// 실행 전과 비교해 적용 여부를 알아내고, 대상 패키지가 업데이트되면 "다시 실행 필요"로 표시합니다.

const PM_VERSION = "1.4.0";
const GH_LIMIT = 8 * 1024 * 1024;
const SCRIPT_LIMIT = 2 * 1024 * 1024;
let stopped = false;
const requests = new Set();
const GH_HOSTS = ["api.github.com", "github.com", "raw.githubusercontent.com"];
const SECTION_ID = "settings-section-external-extensions";
const TARGETS_API = "/api/capability-packages/installed";
const BUNDLE_NAME = "marinara-patches.mjs";
const BACKUP_KIND = "marinara-patch-manager.backup";
const GROUP_COLORS = ["#ec4b97", "#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#fb923c", "#f87171", "#94a3b8"];

// ---------- GitHub ----------

const GH_INPUT_ERROR = "https://github.com/소유자/저장소 또는 저장소 안 파일 주소(…/blob/브랜치/경로)를 입력해 주십시오.";

/** "https://github.com/o/r", "…/tree/main/patch", "…/blob/main/patch/apply-patch.mjs" → { repo, ref, path } */
function parseGitHubInput(value) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw new Error(GH_INPUT_ERROR);
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port || u.username || u.password || u.search) throw new Error(GH_INPUT_ERROR);
  const parts = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || parts.slice(0, 2).some((x) => !/^[\w.-]+$/.test(x))) throw new Error(GH_INPUT_ERROR);
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
  if (parts.length === 2) return { repo, ref: null, path: null };
  if (!["blob", "tree"].includes(parts[2]) || parts.length < 4) throw new Error(GH_INPUT_ERROR);
  return { repo, ref: parts[3], path: parts.length > 4 ? safePath(parts.slice(4).join("/")) : null, kind: parts[2] };
}

function safePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || /[\\\x00-\x1f:]/.test(path) || path.split("/").some((p) => p === ".." || p === "." || !p)) {
    throw new Error("잘못된 파일 경로입니다.");
  }
  return path;
}

async function ghFetch(url) {
  const u = new URL(url);
  if (!GH_HOSTS.includes(u.hostname) || u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("허용되지 않은 다운로드 주소입니다.");
  if (stopped) throw new Error("확장이 종료되었습니다.");
  const controller = new AbortController();
  requests.add(controller);
  const timer = marinara.setTimeout(() => controller.abort(), 25e3);
  try {
    const res = await marinara.fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 404) throw Object.assign(new Error("비공개이거나 삭제된 저장소 또는 파일이라 접근할 수 없습니다."), { notFound: true });
    if (res.status === 403 || res.status === 429) throw new Error("GitHub 조회 한도를 넘었거나 접근이 제한되었습니다. 잠시 후 다시 시도해 주십시오.");
    if (!res.ok) throw new Error(`GitHub 응답 오류 (${res.status})`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > GH_LIMIT) {
        await reader.cancel();
        throw new Error("다운로드가 8MB 제한을 넘습니다.");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(concat(chunks, size)));
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("GitHub 요청 시간이 초과되었습니다.");
    if (err instanceof TypeError) throw new Error("GitHub 연결이 차단되었거나 브라우저가 다운로드를 허용하지 않았습니다.");
    throw err;
  } finally {
    requests.delete(controller);
    marinara.clearTimeout(timer);
  }
}

function concat(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

// Patch scripts: anything under a patch/ or patches/ folder, or a .mjs/.cjs whose name says "patch".
const PATCH_FILE = /(^|\/)(patch|patches)\/[^/]+\.(mjs|cjs|js)$|(^|\/)[^/]*patch[^/]*\.(mjs|cjs)$/i;

async function discoverRepo(input) {
  const { repo, ref, path, kind } = parseGitHubInput(input);
  const info = await ghFetch(`https://api.github.com/repos/${repo}`);
  if (info.private) throw new Error("비공개 저장소는 지원하지 않습니다.");
  const branch = ref || info.default_branch;
  const commit = await ghFetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  const tree = await ghFetch(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Error("저장소가 너무 큽니다. 파일 주소(…/blob/브랜치/경로)를 직접 입력해 주십시오.");
  const blobs = tree.tree.filter((x) => x.type === "blob" && x.mode !== "120000" && !/(^|\/)(node_modules|\.git)\//.test(x.path));
  let choices;
  if (path && kind === "blob") {
    const hit = blobs.find((x) => x.path === path);
    if (!hit) throw new Error(`저장소에서 파일을 찾지 못했습니다: ${path}`);
    choices = [hit];
  } else {
    const inside = path ? blobs.filter((x) => x.path.startsWith(path + "/")) : blobs;
    choices = inside.filter((x) => PATCH_FILE.test(x.path));
  }
  choices = choices.filter((x) => x.size <= SCRIPT_LIMIT).map((x) => ({ path: x.path, size: x.size, label: `${x.path} · ${kb(x.size)}` }));
  if (!choices.length) throw new Error("패치 스크립트를 찾지 못했습니다. patch/ 폴더의 .mjs, 또는 이름에 patch가 들어간 .mjs를 찾습니다. 파일 주소를 직접 넣어도 됩니다.");
  // apply-patch.* first: that is what most repos call the entry point.
  choices.sort((a, b) => /apply-patch/i.test(b.path) - /apply-patch/i.test(a.path) || a.path.localeCompare(b.path));
  return { repo, branch: ref || null, sha: commit.sha, choices };
}

async function fetchRepoFile(repo, path, ref) {
  const item = await ghFetch(`https://api.github.com/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(item) || item.type !== "file") throw new Error("파일이 아닙니다.");
  if (item.size > SCRIPT_LIMIT) throw new Error("패치 스크립트가 2MB를 넘습니다.");
  if (item.encoding !== "base64" || typeof item.content !== "string") throw new Error("지원하지 않는 GitHub 파일 인코딩입니다.");
  return decodeText(Uint8Array.from(atob(item.content.replace(/\s/g, "")), (ch) => ch.charCodeAt(0)));
}

function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error("UTF-8 텍스트 파일이 아닙니다.");
  }
}

/** The newest commit that touched the file, on the branch the link follows (the default branch when none). */
async function latestFileCommit(repo, path, branch) {
  const q = new URLSearchParams({ path, per_page: "1" });
  if (branch) q.set("sha", branch);
  const [commit] = await ghFetch(`https://api.github.com/repos/${repo}/commits?${q}`);
  if (!commit) throw Object.assign(new Error("저장소에서 이 파일이 사라졌습니다. 경로가 바뀌었다면 주소를 다시 연결해 주십시오."), { notFound: true });
  return commit.sha;
}

// ---------- 해시 ----------

const SHA_K = new Uint32Array(64);
const SHA_H0 = new Uint32Array(8);
{
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  primes.forEach((p, i) => {
    SHA_K[i] = Math.floor((Math.cbrt(p) % 1) * 2 ** 32);
    if (i < 8) SHA_H0[i] = Math.floor((Math.sqrt(p) % 1) * 2 ** 32);
  });
}
function sha256Fallback(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 128;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 536870912));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);
  const H = SHA_H0.slice();
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return Array.from(H, (v) => v.toString(16).padStart(8, "0")).join("");
}
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  return globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) => v.toString(16).padStart(2, "0")).join("")
    : sha256Fallback(bytes);
}

// ---------- 패치 스크립트 읽기 ----------

/** What the header comment and the code say about a patch: a name, what it does, which package it edits. */
function inspectScript(text, fileName) {
  const body = text.replace(/\r\n?/g, "\n").replace(/^#!.*\n/, "");
  let name = "";
  let description = "";
  const block = /^\s*\/\*+([\s\S]*?)\*\//.exec(body);
  const lines = block
    ? block[1].split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd())
    : (/^(\s*\/\/.*\n?)+/.exec(body)?.[0] || "").split("\n").map((l) => l.replace(/^\s*\/\/\s?/, "").trimEnd());
  const filled = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
  if (filled.length) {
    name = filled[0].trim();
    description = filled.slice(1).join("\n").trim();
  }
  const target =
    /\bPACKAGE_ID\s*=\s*["'`]([\w.-]+)["'`]/.exec(text)?.[1] ||
    /\bversions["'`]\s*,\s*["'`]([\w.-]+)["'`]/.exec(text)?.[1] ||
    /\b(?:packageId|targetPackage|TARGET)\s*[:=]\s*["'`]([\w.-]+)["'`]/.exec(text)?.[1] ||
    "";
  return {
    name: (name || fallbackName(fileName)).slice(0, 120),
    description: description.slice(0, 1500),
    target,
    restore: /--restore\b/.test(text),
  };
}

/** "gacha-more-money/patch/apply-patch.mjs" → "gacha-more-money · apply-patch": the folder says more than the file. */
function fallbackName(path) {
  const parts = String(path).split("/").filter(Boolean);
  const base = (parts.pop() || "patch").replace(/\.(mjs|cjs|js)$/i, "");
  if (/^patch(es)?$/i.test(parts[parts.length - 1] || "")) parts.pop();
  const owner = parts.pop();
  return owner ? `${owner} · ${base}` : base;
}

function scriptFileName(name) {
  const base = String(name).split("/").pop() || "patch.mjs";
  const clean = base.replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "") || "patch.mjs";
  return /\.(mjs|cjs|js)$/i.test(clean) ? clean : `${clean}.mjs`;
}

async function makePkg(text, fileName, source) {
  if (typeof text !== "string" || !text.trim()) throw new Error("빈 파일입니다.");
  if (new TextEncoder().encode(text).length > SCRIPT_LIMIT) throw new Error("패치 스크립트가 2MB를 넘습니다.");
  const file = scriptFileName(fileName);
  return { text, file, hash: await sha256Hex(text), size: new TextEncoder().encode(text).length, info: inspectScript(text, fileName), source };
}

// ---------- 마리나라 API ----------

function meHeaders(method, hasBody) {
  const headers = {};
  try {
    const secret = localStorage.getItem("marinara_admin_secret")?.trim();
    if (secret) headers["X-Admin-Secret"] = secret;
  } catch {}
  if (method !== "GET") headers["x-marinara-csrf"] = "1";
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function meApi(path) {
  if (stopped) throw new Error("확장이 종료되었습니다.");
  const controller = new AbortController();
  requests.add(controller);
  const timer = marinara.setTimeout(() => controller.abort(), 25e3);
  try {
    const res = await marinara.fetch(path, { signal: controller.signal, method: "GET", headers: meHeaders("GET", false), credentials: "same-origin", cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 403) throw new Error("설치 패키지 목록은 localhost나 관리자 권한(설정 → 고급 → Admin Access)에서만 읽을 수 있습니다.");
      throw new Error(typeof data?.error === "string" ? data.error : `요청 오류 (${res.status})`);
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("마리나라 응답 시간이 초과되었습니다.");
    throw err;
  } finally {
    requests.delete(controller);
    marinara.clearTimeout(timer);
  }
}

/** Installed capability packages, each with a fingerprint of its declared file hashes (a patch rewrites those). */
async function loadTargets() {
  const list = await meApi(TARGETS_API);
  if (!Array.isArray(list)) throw new Error("설치 패키지 목록 응답이 올바르지 않습니다.");
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item.id !== "string") continue;
    map.set(item.id, {
      id: item.id,
      name: typeof item.manifest?.name === "string" ? item.manifest.name : item.id,
      version: String(item.version ?? ""),
      status: item.status,
      error: item.error || item.readinessError || null,
      fingerprint: await fingerprintOf(item.manifest?.files),
    });
  }
  return map;
}

async function fingerprintOf(files) {
  if (!Array.isArray(files)) return null;
  return sha256Hex(JSON.stringify(files.map((f) => [String(f?.path), String(f?.sha256)]).sort((a, b) => a[0].localeCompare(b[0]))));
}

// ---------- data 폴더 검사 ----------
//
// The page can read (and, in Chrome/Edge, delete) files in a folder the user picks. Picking Marinara's data
// folder shows which patches are really inside the installed packages, from the markers patches leave in the
// code (/*이름:start*/, /*이름:head*/), and the backups patches leave beside the files they changed.

const CAP_DIRS = ["capability-packages", "data/capability-packages", "server/data/capability-packages", "packages/server/data/capability-packages"];
const BACKUP_FILE = /\.[\w-]*backup$|\.bak$|\.orig$/i;
const MARKER = /\/\*([\w.-]+):(?:start|head|begin)\*\//g;
const DATA_NOT_FOUND = "고른 폴더에서 capability-packages/installed.json을 찾지 못했습니다. 마리나라 엔진 폴더나 그 안의 packages/server/data 폴더를 골라 주십시오.";

function markerNames(text) {
  return [...new Set(Array.from(String(text).matchAll(MARKER), (m) => m[1]))];
}
const markerCache = new Map();
function markersOf(p) {
  if (!markerCache.has(p.hash)) markerCache.set(p.hash, markerNames(state.scripts[p.id] || ""));
  return markerCache.get(p.hash);
}

async function dirAt(dir, rel) {
  try {
    for (const part of rel.split("/")) dir = await dir.getDirectoryHandle(part);
    return dir;
  } catch {
    return null;
  }
}

/** A folder picked through the File System Access API: read now, asks for write access only when deleting. */
async function handleSource(top) {
  let cap = null;
  for (const rel of CAP_DIRS) {
    const dir = await dirAt(top, rel);
    if (dir && (await dir.getFileHandle("installed.json").catch(() => null))) {
      cap = dir;
      break;
    }
  }
  if (!cap && top.name === "capability-packages" && (await top.getFileHandle("installed.json").catch(() => null))) cap = top;
  if (!cap) throw new Error(DATA_NOT_FOUND);
  return {
    writable: true,
    file: async (path) => (await cap.getFileHandle(path)).getFile(),
    async list(sub) {
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
          else out.push({ path: prefix + name, get: () => handle.getFile(), remove: () => dir.removeEntry(name) });
        }
      };
      const start = await dirAt(cap, sub);
      if (start) await walk(start, `${sub}/`);
      return out;
    },
    async allowWrite() {
      const opts = { mode: "readwrite" };
      return (await top.queryPermission(opts)) === "granted" || (await top.requestPermission(opts)) === "granted";
    },
  };
}

/** A folder picked with a plain folder input (every browser): read only. */
function inputSource(files) {
  const hits = files.filter((f) => /(^|\/)capability-packages\/installed\.json$/.test(f.webkitRelativePath));
  hits.sort((a, b) => a.webkitRelativePath.length - b.webkitRelativePath.length);
  if (!hits.length) throw new Error(DATA_NOT_FOUND);
  const base = hits[0].webkitRelativePath.slice(0, -"installed.json".length);
  const map = new Map(files.filter((f) => f.webkitRelativePath.startsWith(base)).map((f) => [f.webkitRelativePath.slice(base.length), f]));
  return {
    writable: false,
    file: async (path) => map.get(path),
    list: async (sub) => [...map].filter(([path]) => path.startsWith(`${sub}/`)).map(([path, f]) => ({ path, get: async () => f })),
  };
}

// Chrome will not hand a page folders it counts as system locations (AppData and the like) through the
// folder API; the plain folder input still reads them, so that is the fallback (read only).
function pickDataFolder(plain = false) {
  if (!plain && typeof window.showDirectoryPicker === "function") {
    return window.showDirectoryPicker({ id: "marinara-data", mode: "read" }).then(handleSource, (err) => {
      if (err?.name === "AbortError") return null;
      throw err;
    });
  }
  return new Promise((done, fail) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.addEventListener(
      "change",
      () => {
        try {
          done(input.files?.length ? inputSource([...input.files]) : null);
        } catch (err) {
          fail(err);
        }
      },
      { once: true },
    );
    input.click();
  });
}

async function scanDataFolder(src) {
  let registry;
  try {
    registry = JSON.parse(await (await src.file("installed.json")).text());
  } catch {
    throw new Error("installed.json을 읽지 못했습니다.");
  }
  const installed = (Array.isArray(registry?.packages) ? registry.packages : []).filter((x) => x && typeof x.id === "string");
  const entries = await src.list("versions");
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const packages = [];
  for (const pkg of installed) {
    const base = `versions/${pkg.id}/${pkg.version}/`;
    const markers = new Set();
    for (const rel of [pkg.manifest?.entrypoints?.server, pkg.manifest?.entrypoints?.client]) {
      const entry = typeof rel === "string" && rel && byPath.get(base + rel);
      if (entry) for (const name of markerNames(await (await entry.get()).text())) markers.add(name);
    }
    packages.push({
      id: pkg.id,
      name: typeof pkg.manifest?.name === "string" ? pkg.manifest.name : pkg.id,
      version: String(pkg.version ?? ""),
      markers: [...markers],
      fingerprint: await fingerprintOf(pkg.manifest?.files),
    });
  }
  const backups = [];
  for (const entry of entries) {
    if (!BACKUP_FILE.test(entry.path)) continue;
    const file = await entry.get();
    const [, pkgId, version] = entry.path.split("/");
    const pkg = installed.find((x) => x.id === pkgId);
    backups.push({ path: entry.path, size: file.size, modified: file.lastModified, pkgId, current: pkg ? String(pkg.version) === version : false, entry });
  }
  backups.sort((a, b) => a.path.localeCompare(b.path));
  return { at: new Date().toISOString(), writable: src.writable, src, packages, backups };
}

/** Bring the applied records in line with what the scan found inside the packages. */
function applyScan(scan) {
  const at = new Date().toISOString();
  const result = { found: [], gone: [] };
  for (const p of state.patches) {
    const names = markersOf(p);
    const pkg = scan.packages.find((x) => x.id === p.target);
    if (!names.length || !pkg) continue;
    const present = names.some((n) => pkg.markers.includes(n));
    const fingerprint = state.targets?.get(pkg.id)?.fingerprint ?? pkg.fingerprint;
    if (present && statusOf(p) !== "applied") {
      // A record for older code keeps that code's hash: the patch inside is the old one, so it still needs a run.
      p.applied = { hash: p.applied?.hash ?? p.hash, version: pkg.version, fingerprint, at, detected: true };
      result.found.push(p.id);
    } else if (!present && p.applied) {
      p.applied = null;
      result.gone.push(p.id);
    }
  }
  if (state.lastRun) {
    for (const item of state.lastRun.items) if (result.found.includes(item.id) || result.gone.includes(item.id)) item.done = true;
    if (state.lastRun.items.every((x) => x.done)) state.lastRun = null;
  }
  if (result.found.length || result.gone.length) scheduleSave();
  return result;
}

/** Markers in the packages that no patch in the manager leaves. */
function unknownMarkers(pkg) {
  const known = new Set(state.patches.filter((p) => p.target === pkg.id).flatMap(markersOf));
  return pkg.markers.filter((n) => !known.has(n));
}

const CLEANER = String.raw`#!/usr/bin/env node
// 마리나라 패치 백업본 정리 · 패치 관리자 __PM_VERSION__에서 만들었습니다 (__CREATED__).
// 마리나라 엔진 폴더에서 실행합니다(Node.js 필요). 마리나라가 켜져 있어도 됩니다.
//   node marinara-clean-backups.mjs [data 폴더]
// 아래 FILES에 적힌 백업본만 지웁니다(capability-packages 폴더 기준 경로).
import { existsSync, statSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const FILES = __FILES__;
const DATA_DIR = __DATA_DIR__;
const given = process.argv.slice(2).find((a) => !a.startsWith("--"));

function findDataDir() {
  const candidates = [given, DATA_DIR, process.env.DATA_DIR, "packages/server/data", "data", "."].filter(Boolean).map((p) => resolve(p));
  for (const dir of candidates) if (existsSync(join(dir, "capability-packages", "installed.json"))) return dir;
  throw new Error("마리나라 data 폴더를 찾지 못했습니다. 마리나라 엔진 폴더에서 실행하거나 경로를 적어 주세요.\n  찾아본 곳: " + candidates.join(", "));
}

try {
  const root = join(findDataDir(), "capability-packages");
  let removed = 0;
  for (const rel of FILES) {
    const file = resolve(root, ...rel.split("/"));
    if (!file.startsWith(root + sep)) continue;
    if (!existsSync(file) || !statSync(file).isFile()) {
      console.log("없음: " + rel);
      continue;
    }
    rmSync(file);
    removed += 1;
    console.log("지움: " + rel);
  }
  console.log("\n백업본 " + removed + "개를 지웠습니다.");
} catch (e) {
  console.error("실패: " + e.message);
  process.exit(1);
}
`;

function buildCleaner(paths) {
  return CLEANER.replace("__PM_VERSION__", PM_VERSION)
    .replace("__CREATED__", new Date().toLocaleString("ko-KR"))
    .replace("__FILES__", () => JSON.stringify(paths.map(safePath), null, 2))
    .replace("__DATA_DIR__", () => JSON.stringify(state.prefs.dataDir.trim() || null));
}

// ---------- 아이콘 · 공통 ----------

const ICONS = {
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  funnelX: '<path d="M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473"/><path d="m16.5 3.5 5 5"/><path d="m21.5 3.5-5 5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  powerOff: '<path d="M18.36 6.64A9 9 0 0 1 20.77 15"/><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68"/><path d="M12 2v4"/><path d="m2 2 20 20"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  fileCode: '<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>',
  folderSearch: '<path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"/><path d="m21 21-1.9-1.9"/><circle cx="17" cy="17" r="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  circleX: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  arrowUp: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  rows: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
};
function icon(name, size = 14) {
  return `<svg class="pmgr-i${name === "loader" ? " pmgr-spin" : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shortHash = (hash) => String(hash || "").slice(0, 12);

function fmtDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
}
function fmtTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------- 상태 ----------

const STATUS = {
  applied: { label: "적용됨", icon: "circleCheck", css: "on", order: 1 },
  stale: { label: "다시 실행 필요", icon: "shieldAlert", css: "pending", order: 0 },
  waiting: { label: "실행 대기", icon: "clock", css: "pending", order: 2 },
  off: { label: "미적용", icon: "circle", css: "off", order: 3 },
  missing: { label: "대상 없음", icon: "circleX", css: "error", order: 4 },
};
const SORTS = { order: "실행 순서", name: "이름순", added: "최근 추가순", status: "상태순" };

const state = {
  open: false,
  loading: false,
  loadedStorage: false,
  patches: [],
  scripts: {},
  groups: [],
  prefs: { view: "grid", sort: "order", grouped: true, dataDir: "", portCheck: true },
  lastRun: null,
  targets: null,
  targetsError: null,
  filter: { status: "all", pinned: false, group: null, tag: null, gh: null, target: null, q: "" },
  updates: new Map(),
  checking: new Set(),
  checkingAll: null,
  flow: null,
  view: "list",
  runMode: "apply",
  backupPreview: null,
  bulkPanel: null,
  selectedId: null,
  checked: new Set(),
  editingGroup: null,
  groupEdit: false,
  confirmDelete: null,
  helper: null,
  auto: null,
  scan: null,
  scanBusy: "",
  scanError: "",
  scanResult: null,
  confirmBackup: null,
  codeOpen: null,
};
let root = null;
let refs = {};
let saveTimer = 0;
let noticeTimer = 0;

const patchOf = (id) => state.patches.find((p) => p.id === id) || null;
const groupOf = (id) => state.groups.find((g) => g.id === id) || null;
const targetOf = (p) => (p.target && state.targets ? state.targets.get(p.target) || null : null);
const waitingIds = () => new Set((state.lastRun?.items || []).filter((x) => !x.done).map((x) => x.id));

/** { key, reason } for a patch, from its applied record and the installed package as it is now. */
function statusInfo(p) {
  if (isRuntime(p)) return runtimeStatus(p);
  const target = targetOf(p);
  const known = !!state.targets;
  if (known && p.target && !target) return { key: "missing", reason: `대상 패키지 "${p.target}"이(가) 설치되어 있지 않습니다.` };
  if (waitingIds().has(p.id)) return { key: "waiting", reason: state.lastRun.mode === "restore" ? "되돌리기 실행을 기다리는 중입니다. 마리나라를 끄고 실행 파일을 돌린 뒤 다시 켜 주십시오." : "적용 실행을 기다리는 중입니다. 마리나라를 끄고 실행 파일을 돌린 뒤 다시 켜 주십시오." };
  const a = p.applied;
  if (!a) return { key: "off", reason: p.target ? "아직 적용하지 않았습니다." : "대상 패키지를 지정하면 적용 여부를 자동으로 확인합니다." };
  if (a.hash !== p.hash) return { key: "stale", reason: "패치 코드가 바뀌었습니다. 새 코드로 다시 실행해야 합니다." };
  if (target && a.version && target.version !== a.version) return { key: "stale", reason: `대상 패키지가 업데이트되었습니다 (${a.version} → ${target.version}). 업데이트하면 패치가 사라지므로 다시 실행해 주십시오.` };
  if (target && a.fingerprint && target.fingerprint && target.fingerprint !== a.fingerprint) return { key: "stale", reason: "대상 패키지 파일이 적용할 때와 다릅니다(재설치 또는 다른 수정). 다시 실행해 확인해 주십시오." };
  return { key: "applied", reason: `${fmtTime(a.at)}에 적용${a.version ? ` · 대상 ${a.version}` : ""}${!known && p.target ? " · 설치 패키지 목록을 읽지 못해 지금 상태는 확인하지 못했습니다" : ""}` };
}
const statusOf = (p) => statusInfo(p).key;
const labelOf = (p) => statusInfo(p).label || STATUS[statusOf(p)].label;

// ----- 런타임 패치 (NODE_OPTIONS) -----
const runtimeItems = () => state.patches.filter(isRuntime);
const runtimeWanted = () => runtimeItems().filter((p) => p.include && p.rt?.exists !== false).map((p) => p.rt.path);
const runtimeActual = () => runtimeItems().filter((p) => p.rt?.actual).sort((a, b) => a.rt.order - b.rt.order).map((p) => p.rt.path);
const runtimeChanged = () => JSON.stringify(runtimeWanted()) !== JSON.stringify(runtimeActual());
function runtimePending() {
  const wanted = runtimeWanted();
  const actual = runtimeActual();
  const ids = new Set();
  if (JSON.stringify(wanted) === JSON.stringify(actual)) return ids;
  for (const p of runtimeItems()) {
    const on = wanted.includes(p.rt.path);
    if (on !== !!p.rt.actual || (on && wanted.indexOf(p.rt.path) !== actual.indexOf(p.rt.path))) ids.add(p.id);
  }
  return ids;
}
const installedVersion = (t) => state.targets?.get(t.id)?.version ?? t.installed;
function runtimeStatus(p) {
  const rt = p.rt || {};
  if (rt.exists === false) return { key: "missing", label: "파일 없음", reason: `${rt.path} 파일이 없어 마리나라가 시작할 때 오류가 날 수 있습니다. 끄는 것이 좋습니다.` };
  if (runtimePending().has(p.id)) return { key: "waiting", label: "적용 대기", reason: "켜기·끄기나 순서를 바꿨습니다. 재시작해서 적용해야 마리나라에 반영됩니다." };
  if (!rt.actual) return { key: "off", label: "꺼짐", reason: "NODE_OPTIONS에 없어 마리나라가 불러오지 않습니다." };
  const bad = (rt.targets || []).filter((t) => !t.wants.includes(installedVersion(t)));
  if (bad.length)
    return {
      key: "stale",
      label: "버전 다름",
      reason: bad.map((t) => `${t.name} ${t.wants.join("/")}용인데 지금 ${installedVersion(t)}입니다`).join(", ") + ". 이런 패치는 버전이 맞지 않으면 대개 아무것도 바꾸지 않고 조용히 꺼집니다. 새 버전용 패치가 필요합니다.",
    };
  return { key: "applied", label: "켜짐", reason: `마리나라가 시작할 때 ${rt.order + 1}번째로 불러옵니다(파일은 바꾸지 않고 불러올 때 코드만 고침).` };
}

// ---------- 저장 ----------

let saveRevision = 0;
let savedRevision = 0;
let saving = null;
let scriptsDirty = false;
function scheduleSave(scripts = false) {
  if (scripts) scriptsDirty = true;
  saveRevision++;
  marinara.clearTimeout(saveTimer);
  if (!stopped) saveTimer = marinara.setTimeout(() => void flushSave(), 400);
}
function flushSave() {
  marinara.clearTimeout(saveTimer);
  if (saving) return saving;
  if (savedRevision === saveRevision) return Promise.resolve();
  saving = (async () => {
    while (savedRevision !== saveRevision) {
      const revision = saveRevision;
      const withScripts = scriptsDirty;
      scriptsDirty = false;
      const snapshot = JSON.parse(JSON.stringify({ patches: state.patches, groups: state.groups, prefs: state.prefs, lastRun: state.lastRun }));
      if (withScripts) snapshot.scripts = { ...state.scripts };
      try {
        await marinara.storage.patch(snapshot);
      } catch (err) {
        if (withScripts) scriptsDirty = true;
        throw err;
      }
      savedRevision = revision;
    }
  })()
    .catch((err) => {
      marinara.log.warn("Saving failed", err);
      notice("패치 정보를 저장하지 못했습니다. 관리자를 다시 열면 재시도합니다.");
    })
    .finally(() => {
      saving = null;
    });
  return saving;
}
function onVisibilityChange() {
  if (document.visibilityState === "hidden") void flushSave();
}

function cleanPatch(p) {
  if (!isObj(p) || typeof p.id !== "string" || typeof p.name !== "string" || typeof p.hash !== "string") return null;
  return {
    id: p.id,
    name: p.name.slice(0, 120),
    description: typeof p.description === "string" ? p.description.slice(0, 1500) : "",
    file: scriptFileName(p.file || "patch.mjs"),
    target: typeof p.target === "string" ? p.target.slice(0, 120) : "",
    restore: !!p.restore,
    hash: p.hash,
    size: Number(p.size) || 0,
    addedAt: p.addedAt || new Date().toISOString(),
    updatedAt: p.updatedAt || p.addedAt || new Date().toISOString(),
    source: isObj(p.source) && p.source.kind === "github" && typeof p.source.repo === "string" ? p.source : { kind: "local", fileName: isObj(p.source) ? p.source.fileName || p.file : p.file },
    applied: isObj(p.applied) && typeof p.applied.hash === "string" ? p.applied : null,
    include: p.include !== false,
    group: typeof p.group === "string" ? p.group : null,
    tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string").slice(0, 30) : [],
    note: typeof p.note === "string" ? p.note.slice(0, 2000) : "",
    pinned: !!p.pinned,
    kind: p.kind === "runtime" ? "runtime" : "script",
    rt: p.kind === "runtime" && isObj(p.rt) && typeof p.rt.path === "string" ? p.rt : null,
  };
}
// Runtime patches keep no code here: the file lives on the server, and NODE_OPTIONS says whether it loads.
const isRuntime = (p) => p.kind === "runtime";
const hasCode = (p, scripts = state.scripts) => isRuntime(p) || typeof scripts[p.id] === "string";

let storagePromise = null;
function loadStorage() {
  storagePromise ??= readStorage().catch((err) => {
    storagePromise = null;
    throw err;
  });
  return storagePromise;
}
async function readStorage() {
  const stored = (await marinara.storage.get()) || {};
  state.scripts = isObj(stored.scripts) ? stored.scripts : {};
  state.patches = (Array.isArray(stored.patches) ? stored.patches : []).map(cleanPatch).filter((p) => p && hasCode(p));
  state.groups = Array.isArray(stored.groups) ? stored.groups.filter((g) => isObj(g) && g.id && g.name) : [];
  state.prefs = { ...state.prefs, ...(isObj(stored.prefs) ? stored.prefs : {}) };
  state.lastRun = isObj(stored.lastRun) && Array.isArray(stored.lastRun.items) ? stored.lastRun : null;
  state.helper = isObj(stored.helper) ? stored.helper : null;
  state.loadedStorage = true;
}

// ---------- 새로고침 · 적용 확인 ----------

let reloadPromise = null;
function reload() {
  if (stopped) return Promise.resolve();
  reloadPromise ??= (async () => {
    state.loading = true;
    renderSoft();
    try {
      await loadStorage();
      // The helper writes its own key; pick up what it said since the page loaded.
      try {
        const helper = (await marinara.storage.get())?.helper;
        if (isObj(helper)) state.helper = helper;
      } catch {}
      try {
        state.targets = await loadTargets();
        state.targetsError = null;
      } catch (err) {
        state.targets = null;
        state.targetsError = err instanceof Error ? err.message : String(err);
      }
      reconcileRun();
      for (const id of [...state.checked]) if (!patchOf(id)) state.checked.delete(id);
      if (state.selectedId && !patchOf(state.selectedId)) state.selectedId = null;
    } catch (err) {
      marinara.log.warn("Loading failed", err);
      notice("저장된 패치 정보를 불러오지 못했습니다. 잠시 후 새로고침해 주십시오.");
    } finally {
      state.loading = false;
      reloadPromise = null;
      renderSoft();
    }
  })();
  return reloadPromise;
}

/** After the bundle ran (and Marinara restarted), the target's file hashes differ from before the run. */
function reconcileRun() {
  const run = state.lastRun;
  if (!run || !state.targets) return;
  let changed = false;
  let resolved = 0;
  const byTarget = new Map();
  for (const item of run.items) {
    if (item.done || !item.target) continue;
    if (!byTarget.has(item.target)) byTarget.set(item.target, []);
    byTarget.get(item.target).push(item);
  }
  for (const [targetId, items] of byTarget) {
    const now = state.targets.get(targetId);
    const before = items[0].before;
    if (!now || !before || !now.fingerprint || now.fingerprint === before.fingerprint) continue;
    const at = new Date().toISOString();
    for (const p of state.patches) {
      if (p.target !== targetId) continue;
      const item = items.find((x) => x.id === p.id);
      if (item) {
        p.applied = run.mode === "restore" ? null : { hash: item.hash, version: now.version, fingerprint: now.fingerprint, at };
      } else if (p.applied?.fingerprint === before.fingerprint && p.applied.version === now.version) {
        // Another patch on the same package ran; this one stays where it was, so follow the new file hashes.
        p.applied = { ...p.applied, fingerprint: now.fingerprint };
      }
    }
    for (const item of items) item.done = true;
    resolved += items.length;
    changed = true;
  }
  if (run.items.every((x) => x.done)) state.lastRun = null;
  if (changed) {
    scheduleSave();
    notice(`${run.mode === "restore" ? "되돌리기를" : "패치 적용을"} 확인했습니다 · ${resolved}개`);
  }
}

/** Mark patches applied (or not) by hand, taking the installed package as it is now. */
function markApplied(ids, applied) {
  const at = new Date().toISOString();
  for (const id of ids) {
    const p = patchOf(id);
    if (!p) continue;
    const target = targetOf(p);
    p.applied = applied ? { hash: p.hash, version: target?.version || null, fingerprint: target?.fingerprint || null, at } : null;
  }
  if (state.lastRun) {
    for (const item of state.lastRun.items) if (ids.includes(item.id)) item.done = true;
    if (state.lastRun.items.every((x) => x.done)) state.lastRun = null;
  }
  scheduleSave();
  render();
}

// ---------- 업데이트 확인 ----------

async function checkUpdate(p) {
  const src = p.source;
  if (src.kind !== "github" || state.checking.has(p.id) || stopped) return;
  state.checking.add(p.id);
  renderSoft();
  try {
    const sha = await latestFileCommit(src.repo, src.path, src.branch);
    if (patchOf(p.id) !== p || p.source !== src) return;
    src.checkedAt = new Date().toISOString();
    if (sha === src.ref) {
      state.updates.delete(p.id);
      src.message = `최신 상태 · ${fmtTime(src.checkedAt)} 확인`;
      return;
    }
    const pkg = await makePkg(await fetchRepoFile(src.repo, src.path, sha), src.path, { ...src, ref: sha });
    if (patchOf(p.id) !== p || p.source !== src) return;
    if (pkg.hash === p.hash) {
      src.ref = sha;
      state.updates.delete(p.id);
      src.message = `최신 상태 · ${fmtTime(src.checkedAt)} 확인`;
    } else {
      state.updates.set(p.id, pkg);
      src.message = `새 코드 있음 · ${sha.slice(0, 7)}`;
    }
  } catch (err) {
    if (patchOf(p.id) !== p) return;
    state.updates.delete(p.id);
    src.message = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    state.checking.delete(p.id);
    scheduleSave();
    renderSoft();
  }
}

async function checkAll() {
  if (state.checkingAll) return;
  const targets = state.patches.filter((p) => p.source.kind === "github");
  if (!targets.length) return;
  state.checkingAll = { done: 0, total: targets.length };
  let failed = 0;
  for (const p of targets) {
    if (stopped) break;
    try {
      await checkUpdate(p);
    } catch {
      failed += 1;
    }
    state.checkingAll.done += 1;
    renderSoft();
  }
  state.checkingAll = null;
  renderSoft();
  notice(`업데이트 확인 완료 · ${state.updates.size}개 있음${failed ? ` · ${failed}개 확인 실패` : ""}`);
}

// ---------- 패치 저장 · 교체 ----------

function sourceFrom(pkg) {
  const s = pkg.source;
  return s.kind === "github"
    ? { kind: "github", repo: s.repo, path: s.path, branch: s.branch || null, ref: s.ref, checkedAt: new Date().toISOString(), message: "최신 상태 · GitHub에서 받음" }
    : { kind: "local", fileName: s.fileName };
}

// Marinara keeps an extension's whole storage under 1MB, and the patch code lives there too.
const STORAGE_BUDGET = 950_000;
function fitsStorage(extraText, replacingId = null) {
  const scripts = { ...state.scripts };
  if (replacingId) delete scripts[replacingId];
  const size = new TextEncoder().encode(JSON.stringify({ patches: state.patches, scripts, groups: state.groups, prefs: state.prefs, lastRun: state.lastRun, helper: state.helper }) + extraText).length;
  if (size <= STORAGE_BUDGET) return true;
  notice(`마리나라가 확장 하나에 허락하는 저장 공간(1MB)을 넘습니다. 쓰지 않는 패치를 지운 뒤 다시 해 주십시오. (지금 ${kb(size)})`);
  return false;
}

function createPatch(pkg, alreadyApplied) {
  const now = new Date().toISOString();
  const p = cleanPatch({
    id: newId("p"),
    name: pkg.info.name,
    description: pkg.info.description,
    file: pkg.file,
    target: pkg.target ?? pkg.info.target,
    restore: pkg.info.restore,
    hash: pkg.hash,
    size: pkg.size,
    addedAt: now,
    updatedAt: now,
    source: sourceFrom(pkg),
  });
  state.patches.push(p);
  state.scripts[p.id] = pkg.text;
  if (alreadyApplied) {
    const target = targetOf(p);
    p.applied = { hash: p.hash, version: target?.version || null, fingerprint: target?.fingerprint || null, at: now };
  }
  scheduleSave(true);
  return p;
}

function replaceCode(p, pkg) {
  state.scripts[p.id] = pkg.text;
  p.hash = pkg.hash;
  p.size = pkg.size;
  p.file = pkg.file;
  p.description = pkg.info.description || p.description;
  p.restore = pkg.info.restore;
  if (!p.target && pkg.info.target) p.target = pkg.info.target;
  p.updatedAt = new Date().toISOString();
  if (pkg.source.kind === "github") p.source = sourceFrom(pkg);
  state.updates.delete(p.id);
  scheduleSave(true);
}

function deletePatch(id) {
  state.patches = state.patches.filter((p) => p.id !== id);
  delete state.scripts[id];
  state.updates.delete(id);
  state.checked.delete(id);
  if (state.lastRun) {
    state.lastRun.items = state.lastRun.items.filter((x) => x.id !== id);
    if (!state.lastRun.items.some((x) => !x.done)) state.lastRun = null;
  }
  if (state.selectedId === id) state.selectedId = null;
  scheduleSave(true);
}

// ---------- 실행 파일 ----------

// The bundle is one Node file: the patches ride along in base64 and run one by one as
// `node <patch> [--restore] <data 폴더>`, the same way their own READMEs say to run them.
// Written with String.raw so its escapes reach the file as they are; it has no ${} of its own.
const RUNNER = String.raw`#!/usr/bin/env node
// 마리나라 패치 실행 파일 · 패치 관리자 __PM_VERSION__에서 만들었습니다 (__CREATED__).
//
// 마리나라 엔진 폴더에서 실행합니다(Node.js 필요). 마리나라가 켜져 있으면 꺼질 때까지 기다렸다가 패치합니다.
//   node marinara-patches.mjs                 들어 있는 패치를 순서대로 실행
//   node marinara-patches.mjs --restore       거꾸로 되돌리기 (--restore를 지원하는 패치만)
//   node marinara-patches.mjs --apply         되돌리기용으로 받은 파일을 적용으로 실행
//   node marinara-patches.mjs --list          들어 있는 패치 목록만 보기
//   node marinara-patches.mjs [data 폴더]     마리나라 data 폴더를 직접 지정
//   --no-wait                                 마리나라가 켜져 있으면 기다리지 않고 그만두기
//   --force                                   마리나라가 켜져 있어도 바로 실행(권장하지 않음)
// 각 패치는 "node <패치 파일> [--restore] <data 폴더>"로 실행됩니다.
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";

const BUNDLE = __BUNDLE__;
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const given = args.find((a) => !a.startsWith("--"));
const mode = flags.has("--restore") ? "restore" : flags.has("--apply") ? "apply" : BUNDLE.mode;

function findDataDir() {
  const candidates = [given, BUNDLE.dataDir, process.env.DATA_DIR, "packages/server/data", "data", "."].filter(Boolean).map((p) => resolve(p));
  for (const dir of candidates) if (existsSync(join(dir, "capability-packages", "installed.json"))) return dir;
  throw new Error("마리나라 data 폴더를 찾지 못했습니다. 마리나라 엔진 폴더에서 실행하거나 경로를 적어 주세요.\n  예: node marinara-patches.mjs C:\\Marinara-Engine\\packages\\server\\data\n  찾아본 곳: " + candidates.join(", "));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function portOpen() {
  if (!BUNDLE.port) return Promise.resolve(false);
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: BUNDLE.port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// A running Marinara holds a storage writer lease (".writer-lease/owner.json" with its pid) in its data
// folder and drops it on a clean shutdown. A lease left by a crash names a pid that is gone, so it is ignored.
function leaseHeld(dataDir) {
  const dirs = [dataDir];
  try {
    for (const d of readdirSync(dataDir, { withFileTypes: true })) if (d.isDirectory()) dirs.push(join(dataDir, d.name));
  } catch {}
  for (const dir of dirs) {
    try {
      const owner = JSON.parse(readFileSync(join(dir, ".writer-lease", "owner.json"), "utf8"));
      if (Number.isInteger(owner.pid) && (!owner.hostname || owner.hostname === hostname()) && alive(owner.pid)) return true;
    } catch {}
  }
  return false;
}

async function marinaraRunning(dataDir) {
  return BUNDLE.wait !== false && (leaseHeld(dataDir) || (await portOpen()));
}

async function main() {
  if (flags.has("--list")) {
    for (const p of BUNDLE.patches) console.log("- " + p.name + " (" + p.file + (p.target ? ", 대상 " + p.target : "") + (p.restore ? "" : ", 되돌리기 없음") + ")");
    return;
  }
  const list = mode === "restore" ? BUNDLE.patches.filter((p) => p.restore).reverse() : BUNDLE.patches;
  const skipped = BUNDLE.patches.length - list.length;
  if (!list.length) throw new Error(mode === "restore" ? "되돌리기(--restore)를 지원하는 패치가 없습니다." : "실행할 패치가 없습니다.");
  const dataDir = findDataDir();
  console.log("마리나라 data 폴더: " + dataDir);
  // Patching under a running Marinara loses the new hashes (it rewrites the install record), so wait for it to close.
  if (!flags.has("--force") && (await marinaraRunning(dataDir))) {
    if (flags.has("--no-wait")) throw new Error("마리나라가 아직 켜져 있습니다. 마리나라를 끄고 다시 실행해 주세요.");
    console.log("\n마리나라가 아직 켜져 있습니다.");
    console.log("이 창은 그대로 두고 마리나라를 끄세요(런처 창 닫기 또는 Ctrl+C). 꺼지면 바로 패치합니다. (그만두려면 이 창에서 Ctrl+C)");
    console.log("설정의 \"서버 재시작\"은 끄자마자 다시 켜므로 패치할 틈이 생기지 않습니다.");
    // Off has to stay off for a while: a restart brings the next server up within a second or two,
    // and patching while it boots is exactly what loses the new hashes.
    let quiet = 0;
    let warned = false;
    while (quiet < 8) {
      await sleep(1000);
      if (await marinaraRunning(dataDir)) {
        if (quiet > 0 && !warned) {
          warned = true;
          console.log("마리나라가 다시 켜졌습니다(재시작). 완전히 끌 때까지 계속 기다립니다.");
        }
        quiet = 0;
      } else {
        quiet += 1;
      }
    }
    console.log("마리나라가 꺼졌습니다. 패치를 시작합니다.");
  }
  console.log("");
  console.log((mode === "restore" ? "되돌리기" : "적용") + " · 패치 " + list.length + "개" + (skipped ? " (되돌리기를 지원하지 않는 " + skipped + "개는 건너뜀)" : "") + "\n");
  const dir = mkdtempSync(join(tmpdir(), "marinara-patches-"));
  const results = [];
  try {
    for (const [i, p] of list.entries()) {
      console.log("[" + (i + 1) + "/" + list.length + "] " + p.name);
      const code = Buffer.from(p.code, "base64");
      if (createHash("sha256").update(code).digest("hex") !== p.sha256) {
        console.error("  실패: 실행 파일 속 패치 내용이 손상되었습니다.\n");
        results.push([p, false]);
        continue;
      }
      // Each patch in a folder of its own, under its own file name, as if run from where it came from.
      const sub = join(dir, String(i));
      mkdirSync(sub);
      const file = join(sub, p.file);
      writeFileSync(file, code);
      const r = spawnSync(process.execPath, [file, ...(mode === "restore" ? ["--restore"] : []), dataDir], { stdio: "inherit" });
      if (r.error) console.error("  실패: " + r.error.message);
      results.push([p, r.status === 0]);
      console.log("");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log("결과: 성공 " + (results.length - failed.length) + " · 실패 " + failed.length);
  for (const [p] of failed) console.log("  실패한 패치: " + p.name);
  console.log("\n마리나라를 다시 켠 뒤 패치 관리자를 열면 적용 여부를 확인합니다.");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("실패: " + e.message);
  process.exit(1);
});
`;

// ---------- 자동 적용 도우미 ----------
//
// A browser extension cannot touch the server's files, and Marinara's own server extensions run under
// Node's --permission sandbox. So automatic patching needs one small helper on the server machine. The helper
// is Marinara's restart supervisor (it starts the server in place of "pnpm start"): when the manager asks,
// it calls Marinara's own graceful restart, and in the gap — server fully down — runs the patches, then starts
// Marinara again. Jobs travel through this extension's storage, which the helper reads over loopback, so it
// works the same on a home PC, over SSH, or on a rented server. The helper runs only jobs signed with the
// pairing code it printed, which lives only in this browser: whoever can write the extension's storage
// still cannot make the server run code.
const HELPER_NAME = "marinara-patch-helper.mjs";
const HELPER_KEY = "pm-helper-code";
const HELPER_SILENT = "도우미가 응답하지 않습니다. 지금 마리나라를 런처(start.bat, MarinaraLauncher)로 켰다면 도우미가 없는 상태입니다. 마리나라를 끄고, 엔진 폴더에서 node marinara-patch-helper.mjs로 다시 켠 뒤 해 주십시오. 도우미 창에 \"패치 관리자와 연결했습니다\"가 떠 있어야 합니다.";
const HELPER = String.raw`#!/usr/bin/env node
// 마리나라 패치 도우미 · 패치 관리자 __PM_VERSION__
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

const VERSION = "__PM_VERSION__";
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
    if (!child || pending) continue;
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
    linkState("ok", "패치 관리자와 연결했습니다. 이제 [자동 적용] · [서버에서 검사]를 쓸 수 있습니다.");
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
`;

function buildHelper() {
  return HELPER.replaceAll("__PM_VERSION__", PM_VERSION);
}

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
/** HMAC-SHA256 without crypto.subtle: Marinara is often reached over plain http on a LAN or VPS address. */
function hmacHex(key, message) {
  const enc = new TextEncoder();
  let k = enc.encode(key);
  if (k.length > 64) k = hexBytes(sha256Fallback(k));
  const block = new Uint8Array(64);
  block.set(k);
  const join2 = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  const inner = hexBytes(sha256Fallback(join2(block.map((b) => b ^ 0x36), enc.encode(message))));
  return sha256Fallback(join2(block.map((b) => b ^ 0x5c), inner));
}

function helperCode() {
  try {
    const code = (localStorage.getItem(HELPER_KEY) || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    return code.length === 32 ? code : "";
  } catch {
    return "";
  }
}

/** Poll this extension's storage until the helper says something about the job. */
async function waitHelper(test, ms, timeoutMessage) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopped) {
    await new Promise((r) => marinara.setTimeout(r, 1500));
    try {
      const helper = (await marinara.storage.get())?.helper;
      if (isObj(helper)) state.helper = helper;
      if (isObj(helper) && test(helper)) return helper;
    } catch {}
  }
  throw new Error(timeoutMessage);
}

/** A quick job the helper does with Marinara running: scan the data folder, or delete backups and scan again. */
async function helperTask(kind, paths = []) {
  const key = helperCode();
  if (!key) throw new Error("먼저 도우미의 연결 코드를 넣어 주십시오(실행 → 자동 적용).");
  const job = { id: newId("j"), kind, at: new Date().toISOString(), paths };
  job.mac = hmacHex(key, [job.id, kind, job.at, paths.join(",")].join("|"));
  await marinara.storage.patch({ helperJob: job });
  const helper = await waitHelper((h) => h.doneJob === job.id, 30e3, HELPER_SILENT);
  if (helper.error) throw new Error(helper.error);
  if (!isObj(helper.scan) || helper.scan.jobId !== job.id) throw new Error("도우미가 검사 결과를 보내지 않았습니다.");
  return helper.scan;
}

/** Take what the helper found on the server: runtime patches in NODE_OPTIONS order, patch scripts, markers, backups. */
async function useDiscovery(scan) {
  state.scan = {
    at: scan.at,
    writable: true,
    via: "helper",
    packages: scan.packages || [],
    backups: (scan.backups || []).map((b) => ({ ...b, entry: null })),
    runtime: scan.runtime || [],
    nodeOptionsOther: scan.nodeOptionsOther || [],
    scripts: (scan.scripts || []).map(({ path, size }) => ({ path, size })),
  };
  const sync = await syncDiscovery(scan);
  state.scanResult = { ...applyScan(state.scan), ...sync };
  scheduleSave(sync.scripts > 0);
}

async function syncDiscovery(scan) {
  const now = new Date().toISOString();
  const result = { runtimeAdded: [], scriptsAdded: [], scripts: 0 };
  if (!Array.isArray(scan.runtime)) return result;
  const seen = new Set();
  for (const r of scan.runtime) {
    if (!r.inEngine) continue;
    const rt = { path: r.path, value: r.value, exists: r.exists, actual: true, order: r.order, targets: r.targets || [], configs: r.configs || [], size: r.size || 0, seenAt: now };
    let p = state.patches.find((x) => isRuntime(x) && x.rt?.path === r.path);
    if (!p) {
      p = cleanPatch({ id: newId("p"), kind: "runtime", name: r.name || r.path.split("/").pop(), description: r.description || "", file: r.path.split("/").pop(), target: rt.targets[0]?.id || "", hash: r.sha256 || "", size: r.size, addedAt: now, updatedAt: now, source: { kind: "local", fileName: r.path }, rt });
      state.patches.push(p);
      result.runtimeAdded.push(p.id);
    } else {
      p.rt = rt;
      if (r.sha256 && r.sha256 !== p.hash) {
        p.hash = r.sha256;
        p.updatedAt = now;
      }
      if (r.description) p.description = r.description;
    }
    seen.add(p.id);
  }
  // What the server has decides: patches out of NODE_OPTIONS are off, and the load order is NODE_OPTIONS order.
  for (const p of runtimeItems()) {
    if (!seen.has(p.id)) p.rt = { ...p.rt, actual: false };
    p.include = !!p.rt.actual && p.rt.exists !== false;
  }
  orderRuntimeByActual();
  // Patch scripts lying in the add-on folders join the list (their markers then tell whether they are applied).
  for (const sc of Array.isArray(scan.scripts) ? scan.scripts : []) {
    if (typeof sc.code !== "string") continue;
    const pkg = await makePkg(sc.code, sc.path, { kind: "local", fileName: "엔진 폴더/" + sc.path });
    if (state.patches.some((x) => x.hash === pkg.hash)) continue;
    if (!fitsStorage(pkg.text)) break;
    result.scriptsAdded.push(createPatch(pkg, false).id);
    result.scripts += 1;
  }
  return result;
}

/** The NODE_OPTIONS line the manager wants, for putting into .env by hand. */
function runtimeLine() {
  const quote = (v) => (/\s/.test(v) ? `"${v}"` : v);
  const wanted = runtimeItems().filter((p) => p.include && p.rt?.exists !== false && p.rt.value);
  return "NODE_OPTIONS=" + [...(state.scan?.nodeOptionsOther || []), ...wanted.map((p) => "--require=" + quote(p.rt.value))].join(" ");
}

/** Turn runtime patches on/off and set their order: the helper rewrites NODE_OPTIONS while Marinara restarts. */
async function applyRuntime() {
  if (state.auto?.busy) return;
  const key = helperCode();
  if (!key) return notice("도우미 연결 코드가 없습니다. 아래 줄을 .env에 직접 넣고 마리나라를 다시 켜도 됩니다.");
  const requires = runtimeWanted();
  state.auto = { busy: "런타임 패치 설정을 보내는 중…", jobId: null, error: "" };
  render();
  try {
    const job = { id: newId("j"), kind: "runtime", at: new Date().toISOString(), requires };
    job.mac = hmacHex(key, [job.id, "runtime", job.at, requires.join(",")].join("|"));
    state.auto.jobId = job.id;
    await marinara.storage.patch({ helperJob: job });
    const got = await waitHelper((h) => h.seenJob === job.id || h.doneJob === job.id, 20e3, HELPER_SILENT);
    if (got.doneJob !== job.id) {
      state.auto = { ...state.auto, busy: "마리나라를 재시작하며 NODE_OPTIONS를 바꾸는 중… (잠깐 연결이 끊깁니다)" };
      renderSoft();
      await waitHelper((h) => h.doneJob === job.id, 5 * 60e3, "5분 안에 끝나지 않았습니다. 도우미 창을 확인해 주십시오.");
    }
    if (state.helper.error) throw new Error(state.helper.error);
    if (isObj(state.helper.scan)) await useDiscovery(state.helper.scan);
    state.auto = { busy: "", jobId: job.id, error: "" };
    notice("런타임 패치 설정을 적용했습니다.");
  } catch (err) {
    state.auto = { ...state.auto, busy: "", error: err instanceof Error ? err.message : String(err) };
  }
  render();
}

/** Ask the helper to patch: sign the job, hand it over through storage, then follow the restart. */
async function startAuto(list, mode) {
  if (state.auto?.busy) return;
  const key = helperCode();
  if (!key) return notice("먼저 도우미의 연결 코드를 넣어 주십시오.");
  const runnable = mode === "restore" ? list.filter((p) => p.restore) : list;
  if (!runnable.length) return notice(mode === "restore" ? "되돌리기를 지원하는 패치가 없습니다." : "실행 목록에 패치가 없습니다.");
  const step = (busy) => {
    state.auto = { ...state.auto, busy };
    renderSoft();
  };
  state.auto = { busy: "작업을 보내는 중…", jobId: null, error: "" };
  render();
  try {
    // The helper reads the scripts from storage, so they must be saved first.
    scheduleSave(true);
    await flushSave();
    await recordRun(runnable, mode);
    await flushSave();
    const job = { id: newId("j"), mode, at: new Date().toISOString(), patchIds: runnable.map((p) => p.id) };
    job.mac = hmacHex(key, [job.id, job.mode, job.at, runnable.map((p) => p.hash).join(",")].join("|"));
    state.auto.jobId = job.id;
    await marinara.storage.patch({ helperJob: job });
    step("도우미가 받기를 기다리는 중…");
    const until = waitHelper;
    const got = await until((h) => h.seenJob === job.id || h.doneJob === job.id, 20e3, HELPER_SILENT);
    if (got.doneJob !== job.id) {
      step("마리나라를 재시작하고 패치하는 중… (잠깐 연결이 끊깁니다)");
      await until((h) => h.doneJob === job.id, 5 * 60e3, "5분 안에 끝나지 않았습니다. 도우미가 돌아가는 터미널을 확인해 주십시오.");
    }
    if (state.helper.error) throw new Error(state.helper.error);
    state.auto = { busy: "", jobId: job.id, error: "" };
    await reload();
    notice(state.helper.result?.ok ? "자동 적용을 마쳤습니다." : "실패한 패치가 있습니다. 기록을 확인해 주십시오.");
  } catch (err) {
    state.auto = { ...state.auto, busy: "", error: err instanceof Error ? err.message : String(err) };
  }
  render();
}

function base64Of(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function localPort() {
  if (!state.prefs.portCheck || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return 0;
  return Number(location.port) || (location.protocol === "https:" ? 443 : 80);
}

function buildRunner(list, mode) {
  const bundle = {
    mode,
    dataDir: state.prefs.dataDir.trim() || null,
    port: localPort(),
    wait: !!state.prefs.portCheck,
    patches: list.map((p) => ({
      name: p.name,
      file: p.file,
      target: p.target || null,
      restore: p.restore,
      sha256: p.hash,
      code: base64Of(state.scripts[p.id]),
    })),
  };
  return RUNNER.replace("__PM_VERSION__", PM_VERSION)
    .replace("__CREATED__", new Date().toLocaleString("ko-KR"))
    .replace("__BUNDLE__", () => JSON.stringify(bundle, null, 2));
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  marinara.setTimeout(() => URL.revokeObjectURL(url), 1e4);
}

const runList = () => state.patches.filter((p) => p.include && !isRuntime(p) && typeof state.scripts[p.id] === "string");

/** Download a runner for the given patches and remember the packages as they are, to see the run land later. */
async function downloadRunner(list, mode, name = BUNDLE_NAME) {
  if (!list.length) return notice(mode === "restore" ? "되돌리기를 지원하는 패치가 없습니다." : "실행 목록에 패치가 없습니다.");
  if (mode === "restore" && !list.some((p) => p.restore)) return notice("되돌리기(--restore)를 지원하는 패치가 없습니다.");
  await recordRun(list, mode);
  saveFile(name, buildRunner(list, mode), "text/javascript");
  render();
  notice(`${name}을(를) 내려받습니다. 마리나라를 끄고 실행해 주십시오.`);
}

/** Remember the packages as they are before a run, to see the run land after Marinara restarts. */
async function recordRun(list, mode) {
  try {
    state.targets = await loadTargets();
    state.targetsError = null;
  } catch (err) {
    state.targetsError = err instanceof Error ? err.message : String(err);
  }
  const runnable = mode === "restore" ? list.filter((p) => p.restore) : list;
  const at = new Date().toISOString();
  // Patches already applied to the package as it is now count as done: a re-run changes nothing for them.
  state.lastRun = {
    at,
    mode,
    items: runnable.map((p) => {
      const t = targetOf(p);
      const key = statusOf(p);
      return {
        id: p.id,
        hash: p.hash,
        target: p.target || null,
        before: t ? { version: t.version, fingerprint: t.fingerprint } : null,
        done: mode === "apply" ? key === "applied" : !p.applied,
      };
    }),
  };
  if (state.lastRun.items.every((x) => x.done)) state.lastRun = null;
  scheduleSave();
}

function runCommand(name = BUNDLE_NAME) {
  return `node "${name}"`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text });
    area.style.cssText = "position:fixed;opacity:0";
    root.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  notice("복사했습니다.");
}

// ---------- 화면 ----------

function buildShell() {
  root = document.createElement("div");
  root.className = "pmgr-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "패치 관리자");
  root.innerHTML = `
        <div class="pmgr-backdrop" data-act="close"></div>
        <div class="pmgr-panel">
            <header class="pmgr-header">
                <div class="pmgr-title">
                    <span class="pmgr-title-icon">${icon("wrench", 16)}</span>
                    <div class="pmgr-title-text">
                        <strong>패치 관리자</strong>
                        <span class="pmgr-sub" data-ref="sub"></span>
                    </div>
                </div>
                <div class="pmgr-search-row">
                    <button type="button" class="pmgr-icon-btn pmgr-menu-btn" data-act="side-toggle" title="필터 메뉴" aria-label="필터 메뉴">${icon("panelLeft", 16)}</button>
                    <label class="pmgr-search">
                        ${icon("search", 14)}
                        <input type="search" data-ref="search" aria-label="패치 검색" placeholder="이름, 설명, 대상, 태그, 메모 검색 · Enter" autocomplete="off" spellcheck="false">
                    </label>
                    <button type="button" class="pmgr-icon-btn pmgr-refresh-btn is-mobile" data-act="refresh" title="새로고침 · 업데이트 확인" aria-label="새로고침 · 업데이트 확인">${icon("refresh", 15)}</button>
                </div>
                <div class="pmgr-header-actions">
                    <button type="button" class="pmgr-head-btn" data-act="add-open" title="파일 또는 GitHub 저장소에서 패치 추가">${icon("plus", 14)}<span>패치 추가</span></button>
                    <button type="button" class="pmgr-head-btn" data-act="run-open" title="켜 둔 패치를 한 번에 실행하는 파일 받기">${icon("terminal", 14)}<span>실행</span></button>
                    <button type="button" class="pmgr-head-btn" data-act="scan-open" title="마리나라 data 폴더에서 들어 있는 패치와 백업본 찾기">${icon("folderSearch", 14)}<span>검사</span></button>
                    <button type="button" class="pmgr-icon-btn" data-act="settings-open" title="설정" aria-label="설정">${icon("settings", 15)}</button>
                    <button type="button" class="pmgr-icon-btn pmgr-refresh-btn is-desktop" data-act="refresh" title="새로고침 · 업데이트 확인" aria-label="새로고침 · 업데이트 확인">${icon("refresh", 15)}</button>
                    <button type="button" class="pmgr-icon-btn" data-act="close" title="닫기" aria-label="닫기">${icon("x", 16)}</button>
                </div>
            </header>
            <div class="pmgr-body">
                <div class="pmgr-scrim" data-act="side-close"></div>
                <aside class="pmgr-side" data-ref="side"></aside>
                <main class="pmgr-main" data-ref="main"></main>
                <section class="pmgr-detail" data-ref="detail"></section>
            </div>
            <div class="pmgr-notice" data-ref="notice" role="status" aria-live="polite"></div>
        </div>`;
  refs = {};
  for (const el of root.querySelectorAll("[data-ref]")) refs[el.dataset.ref] = el;
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-tag-suggest]")) event.preventDefault();
  });
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("dragend", onDragEnd);
}

function navItem(act, value, active, iconHtml, label, count, extra = "") {
  return `<button type="button" class="pmgr-nav${active ? " is-active" : ""}" data-act="${act}" data-v="${esc(value)}">
        ${iconHtml}<span class="pmgr-nav-label">${esc(label)}</span>${extra}<span class="pmgr-count">${count}</span></button>`;
}

const renderedHtml = new WeakMap();
function setHtml(element, html) {
  if (renderedHtml.get(element) === html) return;
  const active = element.contains(document.activeElement) ? document.activeElement : null;
  const focusSelector = active?.dataset.act
    ? active.tagName.toLowerCase() + '[data-act="' + CSS.escape(active.dataset.act) + '"]' + (active.dataset.id ? '[data-id="' + CSS.escape(active.dataset.id) + '"]' : "")
    : null;
  renderedHtml.set(element, html);
  element.innerHTML = html;
  if (focusSelector) element.querySelector(focusSelector)?.focus({ preventScroll: true });
}

function allTags() {
  const counts = new Map();
  for (const p of state.patches) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0], "ko"));
}

function targetLabel(id) {
  const t = state.targets?.get(id);
  return t && t.name !== id ? `${t.name} (${id})` : id;
}

function matches(p) {
  const f = state.filter;
  if (f.status !== "all" && statusOf(p) !== f.status) return false;
  if (f.group === "__none" && groupOf(p.group)) return false;
  if (f.group && f.group !== "__none" && p.group !== f.group) return false;
  if (f.tag && !p.tags.includes(f.tag)) return false;
  if (f.target && p.target !== f.target) return false;
  if (f.gh === "linked" && p.source.kind !== "github") return false;
  if (f.gh === "update" && !state.updates.has(p.id)) return false;
  if (f.gh === "excluded" && p.include) return false;
  if (f.gh === "runtime" && !isRuntime(p)) return false;
  if (f.gh === "script" && isRuntime(p)) return false;
  if (f.pinned && !p.pinned) return false;
  if (f.q) {
    const hay = [p.name, p.description, p.file, p.target, targetOf(p)?.name, p.note, ...p.tags, groupOf(p.group)?.name, p.source.repo, p.source.path]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function sorted(list) {
  const sort = state.prefs.sort;
  const index = (p) => state.patches.indexOf(p);
  const byName = (a, b) => a.name.localeCompare(b.name, "ko");
  return [...list].sort((a, b) => {
    const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pin && sort !== "order") return pin;
    if (sort === "name") return byName(a, b);
    if (sort === "added") return String(b.addedAt).localeCompare(String(a.addedAt)) || byName(a, b);
    if (sort === "status") return STATUS[statusOf(a)].order - STATUS[statusOf(b)].order || index(a) - index(b);
    return index(a) - index(b);
  });
}

const filterActive = () => {
  const f = state.filter;
  return f.status !== "all" || f.pinned || f.group || f.tag || f.gh || f.target || f.q;
};
function filterCrumb() {
  const f = state.filter;
  const group = !f.group ? "전체" : f.group === "__none" ? "미분류" : groupOf(f.group)?.name || "전체";
  const extra = [
    f.pinned && "즐겨찾기",
    f.target && `대상 ${f.target}`,
    f.gh === "linked" && "GitHub 연결됨",
    f.gh === "update" && "업데이트 있음",
    f.gh === "excluded" && "꺼짐 · 실행 목록에서 뺌",
    f.gh === "runtime" && "런타임 패치",
    f.gh === "script" && "파일 패치",
    f.tag && `#${f.tag}`,
  ].filter(Boolean);
  return `${group} > ${f.status === "all" ? "전체" : STATUS[f.status].label}${extra.length ? `, ${extra.join(", ")}` : ""}`;
}
const resetFilter = () => {
  state.filter = { status: "all", pinned: false, group: null, tag: null, gh: null, target: null, q: "" };
  if (refs.search) refs.search.value = "";
};

function renderSide() {
  const f = state.filter;
  const items = state.patches;
  const count = (pred) => items.filter(pred).length;
  const statusRows = [
    ["all", icon("rows", 14), "전체", items.length],
    ...["stale", "waiting", "applied", "off", "missing"].map((key) => [key, icon(STATUS[key].icon, 14), STATUS[key].label, count((p) => statusOf(p) === key)]),
  ].filter(([key, , , n]) => key === "all" || key === "applied" || key === "off" || n > 0 || f.status === key);
  const groupCount = (id) => count((p) => p.group === id);
  const ungrouped = count((p) => !groupOf(p.group));
  const groups = state.groups
    .map((g, index) => {
      if (state.editingGroup === g.id) {
        return `<div class="pmgr-nav is-editing"><span class="pmgr-dot" style="--c:${esc(g.color)}"></span>
                <input class="pmgr-inline-input" data-group-input="${esc(g.id)}" value="${esc(g.name)}" maxlength="40"></div>`;
      }
      return `<div class="pmgr-nav-wrap" draggable="true" data-group-drag="${esc(g.id)}" title="끌어서 순서 변경">
            ${navItem("f-group", g.id, f.group === g.id, `<span class="pmgr-dot" style="--c:${esc(g.color)}"></span>`, g.name, groupCount(g.id))}
            <span class="pmgr-nav-tools">
                <button type="button" class="pmgr-group-up" data-act="group-up" data-id="${esc(g.id)}"${index ? "" : " disabled"} title="위로" aria-label="위로 이동">${icon("chevronUp", 12)}</button>
                <button type="button" data-act="group-color" data-id="${esc(g.id)}" title="색 바꾸기" aria-label="색 바꾸기"><span class="pmgr-dot" style="--c:${esc(g.color)}"></span></button>
                <button type="button" data-act="group-rename" data-id="${esc(g.id)}" title="이름 바꾸기" aria-label="이름 바꾸기">${icon("pencil", 12)}</button>
                <button type="button" data-act="group-del" data-id="${esc(g.id)}" title="그룹 삭제 (패치는 미분류로 이동)" aria-label="그룹 삭제">${icon("trash", 12)}</button>
            </span></div>`;
    })
    .join("");
  const newGroup =
    state.editingGroup === "new"
      ? `<div class="pmgr-nav is-editing">${icon("folder", 14)}<input class="pmgr-inline-input" data-group-input="new" placeholder="새 그룹 이름" maxlength="40"></div>`
      : `<button type="button" class="pmgr-nav pmgr-nav-add" data-act="group-add">${icon("plus", 14)}<span class="pmgr-nav-label">새 그룹</span></button>`;
  const targetIds = [...new Set(items.map((p) => p.target).filter(Boolean))].sort();
  const targetBlock = targetIds.length
    ? `<div class="pmgr-side-block">
            <div class="pmgr-side-title">대상 패키지</div>
            ${targetIds.map((id) => navItem("f-target", id, f.target === id, icon("package", 14), targetLabel(id), count((p) => p.target === id))).join("")}
        </div>`
    : "";
  const linked = count((p) => p.source.kind === "github");
  const updates = count((p) => state.updates.has(p.id));
  const excluded = count((p) => !p.include);
  const runtimeCount = count(isRuntime);
  const all = state.checkingAll;
  const ghBlock =
    linked || excluded || runtimeCount
      ? `<div class="pmgr-side-block">
            <div class="pmgr-side-title">종류 · 출처</div>
            ${runtimeCount ? navItem("f-gh", "runtime", f.gh === "runtime", icon("terminal", 14), "런타임 패치", runtimeCount) : ""}
            ${runtimeCount ? navItem("f-gh", "script", f.gh === "script", icon("fileCode", 14), "파일 패치", items.length - runtimeCount) : ""}
            ${linked ? navItem("f-gh", "linked", f.gh === "linked", icon("github", 14), "GitHub 연결됨", linked) : ""}
            ${updates ? navItem("f-gh", "update", f.gh === "update", icon("arrowUp", 14), "업데이트 있음", updates) : ""}
            ${excluded ? navItem("f-gh", "excluded", f.gh === "excluded", icon("powerOff", 14), "꺼짐 · 목록에서 뺌", excluded) : ""}
            ${linked ? `<button type="button" class="pmgr-nav pmgr-nav-add" data-act="gh-check-all"${all ? " disabled" : ""}>${icon(all ? "loader" : "refresh", 14)}<span class="pmgr-nav-label">${all ? `확인 중 ${all.done}/${all.total}` : "업데이트 모두 확인"}</span></button>` : ""}
        </div>`
      : "";
  const tags = allTags();
  setHtml(
    refs.side,
    `
        <div class="pmgr-side-block">
            ${navItem("f-pinned", "1", f.pinned, icon("pin", 14), "즐겨찾기", count((p) => p.pinned))}
        </div>
        <div class="pmgr-side-block">
            <div class="pmgr-side-title">상태</div>
            ${statusRows.map(([key, ic, label, n]) => navItem("f-status", key, f.status === key, ic, label, n)).join("")}
        </div>
        ${targetBlock}
        <div class="pmgr-side-block">
            <div class="pmgr-side-title pmgr-side-title-row">그룹${state.groups.length ? `<button type="button" class="pmgr-side-edit${state.groupEdit ? " is-on" : ""}" data-act="group-edit" aria-pressed="${state.groupEdit}" title="${state.groupEdit ? "편집 완료" : "그룹 편집"}" aria-label="${state.groupEdit ? "편집 완료" : "그룹 편집"}">${icon(state.groupEdit ? "check" : "pencil", 12)}</button>` : ""}</div>
            ${state.groups.length ? navItem("f-group-all", "", !f.group, icon("layers", 14), "전체", items.length) : ""}
            ${groups}
            ${state.groups.length ? navItem("f-group", "__none", f.group === "__none", icon("inbox", 14), "미분류", ungrouped) : ""}
            ${newGroup}
        </div>
        ${ghBlock}
        ${
          tags.length
            ? `<div class="pmgr-side-block">
            <div class="pmgr-side-title">태그</div>
            <div class="pmgr-tag-cloud">${tags.map(([t, n]) => `<button type="button" class="pmgr-tag${f.tag === t ? " is-active" : ""}" data-act="f-tag" data-v="${esc(t)}">#${esc(t)}<span>${n}</span></button>`).join("")}</div>
        </div>`
            : ""
        }`,
  );
  refs.side.classList.toggle("is-group-edit", state.groupEdit);
  const input = refs.side.querySelector("[data-group-input]");
  if (input) {
    input.focus();
    input.select();
  }
}

const groupedView = () => state.prefs.grouped && state.groups.length > 0 && !state.filter.group && state.prefs.sort !== "order";

function statusPill(p) {
  const key = statusOf(p);
  const update = state.updates.has(p.id) ? `<span class="pmgr-status is-update" title="GitHub에 새 코드가 있습니다">${icon("arrowUp", 11)}업데이트</span>` : "";
  return `<span class="pmgr-status is-${STATUS[key].css}">${icon(STATUS[key].icon, 11)}${esc(labelOf(p))}</span>${update}`;
}

function targetChip(p) {
  if (isRuntime(p)) {
    const ts = p.rt?.targets || [];
    return ts.length
      ? ts.map((t) => `<span class="pmgr-chip" title="이 패치가 맞춘 버전 · 지금 설치 ${esc(installedVersion(t))}">${icon("package", 11)}${esc(t.name)} ${esc(t.wants.join("/"))}</span>`).join("")
      : `<span class="pmgr-chip" title="특정 패키지 버전에 매이지 않음">${icon("package", 11)}엔진 전반</span>`;
  }
  if (!p.target) return `<span class="pmgr-chip" title="대상 패키지 미지정">${icon("package", 11)}대상 미지정</span>`;
  const t = targetOf(p);
  return `<span class="pmgr-chip" title="${esc(targetLabel(p.target))}">${icon("package", 11)}${esc(t?.name || p.target)}${t?.version ? ` ${esc(t.version)}` : ""}</span>`;
}

function card(p) {
  const group = groupedView() ? null : groupOf(p.group);
  const key = statusOf(p);
  const checked = state.checked.has(p.id);
  const selected = state.selectedId === p.id;
  const id = esc(p.id);
  const tagHtml = `${p.tags
    .slice(0, 3)
    .map((t) => `<span class="pmgr-chip">#${esc(t)}</span>`)
    .join("")}${p.tags.length > 3 ? `<span class="pmgr-chip">+${p.tags.length - 3}</span>` : ""}`;
  const tint = groupOf(p.group)?.color;
  const common = `data-act="select" data-id="${id}"${tint ? ` style="--pm-on:${esc(tint)}"` : ""}`;
  const check = `<button type="button" class="pmgr-check${checked ? " is-on" : ""}" data-act="check" data-id="${id}" aria-pressed="${checked}" aria-label="선택">${icon("check", 11)}</button>`;
  const pin = `<button type="button" class="pmgr-pin${p.pinned ? " is-on" : ""}" data-act="pin" data-id="${id}" aria-pressed="${p.pinned}" title="${p.pinned ? "고정 해제" : "위에 고정"}" aria-label="고정">${icon("pin", 13)}</button>`;
  const includeLabel = isRuntime(p) ? (p.include ? "끄기 (재시작해서 적용)" : "켜기 (재시작해서 적용)") : p.include ? "실행 목록에서 빼기" : "실행 목록에 넣기";
  const actions = `<div class="pmgr-card-actions">
        <button type="button" class="pmgr-act${p.include ? " is-on" : ""}" data-act="include" data-id="${id}" title="${includeLabel}" aria-label="${includeLabel}">${icon(p.include ? "power" : "powerOff", 13)}</button>
        ${isRuntime(p) ? "" : `<button type="button" class="pmgr-act" data-act="run-one" data-id="${id}" title="이 패치만 실행하는 파일 받기" aria-label="이 패치만 실행하는 파일 받기">${icon("download", 13)}</button>`}
        <button type="button" class="pmgr-act is-danger" data-act="delete" data-id="${id}" title="삭제" aria-label="삭제">${icon("trash", 13)}</button></div>`;
  const cls = `is-${STATUS[key].css}${checked ? " is-checked" : ""}${selected ? " is-selected" : ""}${p.include ? "" : " is-excluded"}`;
  const order = state.prefs.sort === "order" ? `<span class="pmgr-order">${state.patches.indexOf(p) + 1}</span>` : "";
  const badges = isRuntime(p) ? `<span class="pmgr-badge is-runtime" title="NODE_OPTIONS --require로 불러오는 런타임 패치">${icon("terminal", 11)}런타임</span>` : `${p.source.kind === "github" ? `<span class="pmgr-badge" title="${esc(p.source.repo)}">${icon("github", 11)}</span>` : `<span class="pmgr-badge" title="파일에서 추가">${icon("fileCode", 11)}</span>`}${p.restore ? `<span class="pmgr-badge" title="--restore로 되돌릴 수 있음">${icon("undo", 11)}</span>` : ""}`;
  if (state.prefs.view === "list") {
    return `<div class="pmgr-row ${cls}" ${common}>
            ${check}
            <span class="pmgr-row-dot is-${STATUS[key].css}" title="${esc(labelOf(p))}"></span>
            <div class="pmgr-row-main">
                <div class="pmgr-row-name">${order}<strong><button type="button" class="pmgr-name-button" data-act="select" data-id="${id}" aria-label="${esc(p.name)} 상세">${esc(p.name)}</button></strong><span class="pmgr-ver">${esc(isRuntime(p) ? p.rt.path : p.file)}</span>${state.updates.has(p.id) ? `<span class="pmgr-status is-update">${icon("arrowUp", 11)}업데이트</span>` : ""}${p.note ? `<span class="pmgr-has-note" title="메모 있음">${icon("note", 11)}</span>` : ""}</div>
                <div class="pmgr-row-desc">${esc(p.description || "설명 없음")}</div>
            </div>
            <div class="pmgr-row-meta">${targetChip(p)}${group ? `<span class="pmgr-chip is-group"><span class="pmgr-dot" style="--c:${esc(group.color)}"></span>${esc(group.name)}</span>` : ""}${tagHtml}${badges}</div>
            <span class="pmgr-row-date">${fmtDate(p.updatedAt)}</span>
            <div class="pmgr-row-tools">${pin}${actions}</div>
        </div>`;
  }
  return `<article class="pmgr-card ${cls}" ${common}>
        <div class="pmgr-card-top">${order}${statusPill(p)}<span class="pmgr-grow"></span>${pin}${check}</div>
        <div class="pmgr-card-name"><strong><button type="button" class="pmgr-name-button" data-act="select" data-id="${id}" title="${esc(p.name)}" aria-label="${esc(p.name)} 상세">${esc(p.name)}</button></strong></div>
        <p class="pmgr-card-desc">${esc(p.description || "설명 없음")}</p>
        <div class="pmgr-card-chips">${targetChip(p)}${group ? `<span class="pmgr-chip is-group"><span class="pmgr-dot" style="--c:${esc(group.color)}"></span>${esc(group.name)}</span>` : ""}${tagHtml}${p.note ? `<span class="pmgr-has-note" title="메모 있음">${icon("note", 11)}</span>` : ""}</div>
        <div class="pmgr-card-foot"><div class="pmgr-badges">${badges}</div>${actions}</div>
    </article>`;
}

function orderRuntimeByActual() {
  const slots = state.patches.map((p, i) => (isRuntime(p) ? i : -1)).filter((i) => i >= 0);
  const ordered = slots.map((i) => state.patches[i]).sort((a, b) => (a.rt.actual ? a.rt.order : 1e6) - (b.rt.actual ? b.rt.order : 1e6));
  slots.forEach((slot, i) => (state.patches[slot] = ordered[i]));
}

function runtimeBanner() {
  if (!runtimeChanged()) return "";
  const busy = state.auto?.busy;
  const line = runtimeLine();
  const code = helperCode();
  return `<div class="pmgr-banner">
        ${icon("clock", 14)}
        <div class="pmgr-banner-text"><strong>런타임 패치 변경 ${runtimePending().size}건 · 아직 반영 안 됨</strong>
        <span>마리나라는 NODE_OPTIONS를 켤 때만 읽으므로 재시작해야 반영됩니다. ${code ? "[재시작해서 적용]을 누르면 도우미가 .env를 바꾸고 마리나라를 다시 켭니다." : "도우미가 없으면 .env의 NODE_OPTIONS 줄을 아래로 바꾸고 마리나라를 다시 켜 주십시오."}</span>
        <div class="pmgr-cmd"><code>${esc(line)}</code><button type="button" class="pmgr-icon-btn" data-act="copy" data-v="${esc(line)}" title="복사" aria-label="NODE_OPTIONS 줄 복사">${icon("copy", 13)}</button></div>
        ${state.auto?.error ? `<span class="pmgr-err">${esc(state.auto.error)}</span>` : ""}</div>
        <div class="pmgr-banner-actions">
            <button type="button" class="pmgr-btn is-primary" data-act="runtime-apply"${busy || !code ? " disabled" : ""}>${icon(busy ? "loader" : "refresh", 13)}${busy ? esc(busy) : "재시작해서 적용"}</button>
            <button type="button" class="pmgr-btn is-ghost" data-act="runtime-revert"${busy ? " disabled" : ""}>바꾼 것 취소</button>
        </div>
    </div>`;
}

function runBanner() {
  const run = state.lastRun;
  if (!run) return "";
  const waiting = run.items.filter((x) => !x.done);
  return `<div class="pmgr-banner">
        ${icon("clock", 14)}
        <div class="pmgr-banner-text"><strong>${run.mode === "restore" ? "되돌리기" : "적용"} 실행 대기 · ${waiting.length}개</strong>
        <span>${fmtTime(run.at)}에 실행 파일을 받았습니다. 마리나라를 끄고 실행한 뒤 다시 켜면 자동으로 확인합니다.</span></div>
        <div class="pmgr-banner-actions">
            <button type="button" class="pmgr-btn" data-act="run-confirm">${icon("check", 13)}${run.mode === "restore" ? "되돌렸음" : "적용했음"}</button>
            <button type="button" class="pmgr-btn is-ghost" data-act="run-dismiss">취소</button>
        </div>
    </div>`;
}

function renderList() {
  const prefs = state.prefs;
  const visible = sorted(state.patches.filter(matches));
  const toolbar = `<div class="pmgr-toolbar">
        ${state.loading && !state.loadedStorage ? '<span class="pmgr-result">불러오는 중…</span>' : `${filterActive() ? `<button type="button" class="pmgr-seg-btn" data-act="f-reset" title="필터 초기화" aria-label="필터 초기화">${icon("funnelX", 13)}</button>` : ""}<span class="pmgr-result pmgr-crumb">${esc(filterCrumb())}</span>`}
        <span class="pmgr-grow"></span>
        <label class="pmgr-select">${icon("rows", 13)}
            <select data-ref-sort aria-label="정렬">${Object.entries(SORTS)
              .map(([k, v]) => `<option value="${k}"${prefs.sort === k ? " selected" : ""}>${v}</option>`)
              .join("")}</select>
        </label>
        ${state.groups.length && prefs.sort !== "order" ? `<button type="button" class="pmgr-seg-btn${prefs.grouped ? " is-active" : ""}" data-act="grouped" title="그룹별로 묶어 보기">${icon("folder", 13)}<span>그룹별</span></button>` : ""}
        <div class="pmgr-seg" role="group" aria-label="보기 방식">
            <button type="button" class="${prefs.view === "grid" ? "is-active" : ""}" data-act="view" data-v="grid" title="카드" aria-label="카드 보기">${icon("grid", 13)}</button>
            <button type="button" class="${prefs.view === "list" ? "is-active" : ""}" data-act="view" data-v="list" title="목록" aria-label="목록 보기">${icon("list", 13)}</button>
        </div>
    </div>`;
  const targetsWarn = state.targetsError && state.patches.some((p) => p.target)
    ? `<div class="pmgr-flow-note is-warn">${icon("shieldAlert", 13)}<span>설치 패키지 목록을 읽지 못해 적용 여부를 확인하지 못했습니다: ${esc(state.targetsError)}</span></div>`
    : "";
  let content;
  if (!state.loadedStorage && state.loading) {
    content = `<div class="pmgr-grid">${'<div class="pmgr-skeleton"></div>'.repeat(6)}</div>`;
  } else if (!state.patches.length) {
    content = `<div class="pmgr-empty">${icon("wrench", 22)}<strong>추가한 패치가 없습니다</strong><span>patch/apply-patch.mjs 같은 패치 스크립트를 GitHub 저장소나 파일에서 추가할 수 있습니다.</span><button type="button" class="pmgr-btn is-primary" data-act="add-open">${icon("plus", 13)}패치 추가</button></div>`;
  } else if (!visible.length) {
    content = `<div class="pmgr-empty">${icon("search", 22)}<strong>조건에 맞는 패치가 없습니다</strong><button type="button" class="pmgr-btn" data-act="f-reset">필터 초기화</button></div>`;
  } else {
    const wrap = (list) => `<div class="${prefs.view === "list" ? "pmgr-list" : "pmgr-grid"}">${list.map(card).join("")}</div>`;
    if (groupedView()) {
      content = [...state.groups.map((g) => [g, visible.filter((p) => p.group === g.id)]), [null, visible.filter((p) => !groupOf(p.group))]]
        .filter(([, list]) => list.length)
        .map(
          ([g, list]) => `<section class="pmgr-section">
                <h3 class="pmgr-section-title">${g ? `<span class="pmgr-dot" style="--c:${esc(g.color)}"></span>${esc(g.name)}` : `${icon("inbox", 13)}미분류`}<span>${list.length}</span></h3>
                ${wrap(list)}</section>`,
        )
        .join("");
    } else {
      content = wrap(visible);
    }
  }
  setHtml(refs.main, `${toolbar}<div class="pmgr-scroll">${runtimeBanner()}${runBanner()}${targetsWarn}${content}</div>${bulkHtml()}`);
}

function bulkHtml() {
  const ids = [...state.checked];
  if (!ids.length) {
    state.bulkPanel = null;
    return "";
  }
  const pinned = ids.every((id) => patchOf(id)?.pinned);
  const first = groupOf(patchOf(ids[0])?.group)?.id || "";
  const shared = ids.every((id) => (groupOf(patchOf(id)?.group)?.id || "") === first) ? first : null;
  const panelBtn = (v, ico, label) =>
    `<button type="button" class="pmgr-icon-btn${state.bulkPanel === v ? " is-on" : ""}" data-act="bulk-panel" data-v="${v}" aria-expanded="${state.bulkPanel === v}" aria-label="${label}" title="${label}">${icon(ico, 15)}</button>`;
  let panel = "";
  if (state.bulkPanel === "group") {
    const groups = [["", "미분류", null], ...state.groups.map((g) => [g.id, g.name, g.color])];
    panel = `<div class="pmgr-bulk-panel">
            <span class="pmgr-field-label">${icon("folder", 12)}그룹으로 이동</span>
            <div class="pmgr-tag-cloud pmgr-tag-suggest">${groups.map(([v, name, c]) => `<button type="button" class="pmgr-tag${shared === v ? " is-active" : ""}" data-act="bulk-group" data-v="${esc(v)}">${c ? `<span class="pmgr-dot" style="--c:${esc(c)}"></span>` : icon("inbox", 11)}${esc(name)}</button>`).join("")}</div>
        </div>`;
  } else if (state.bulkPanel === "tag") {
    panel = `<div class="pmgr-bulk-panel">
            <label class="pmgr-tag-input">${icon("tag", 13)}<input data-bulk-tag placeholder="태그 추가 (Enter, 쉼표, #)" enterkeyhint="done"></label>
            <div class="pmgr-tag-cloud pmgr-tag-suggest" data-tag-suggest></div>
        </div>`;
  }
  return `<div class="pmgr-bulk">${panel}
        <div class="pmgr-bulk-row">
            <button type="button" class="pmgr-icon-btn" data-act="bulk-clear" aria-label="선택 해제" title="선택 해제">${icon("x", 15)}</button>
            <strong>${ids.length}개 선택</strong>
            ${panelBtn("group", "folder", "그룹 이동")}
            ${panelBtn("tag", "tag", "태그 추가")}
            <button type="button" class="pmgr-icon-btn${pinned ? " is-on" : ""}" data-act="bulk-pin" aria-pressed="${pinned}" aria-label="${pinned ? "고정 해제" : "고정"}" title="${pinned ? "고정 해제" : "고정"}">${icon("pin", 15)}</button>
            <button type="button" class="pmgr-icon-btn" data-act="bulk-run" aria-label="선택한 패치만 실행하는 파일 받기" title="선택한 패치만 실행하는 파일 받기">${icon("download", 15)}</button>
        </div>
    </div>`;
}

// ----- 추가 · 연결 · 업데이트 흐름 -----

function flowStatusHtml(flow) {
  if (flow.busy) return `<div class="pmgr-flow-status">${icon("loader", 13)}${esc(flow.busy)}</div>`;
  if (flow.error) return `<div class="pmgr-flow-status is-error">${icon("circleX", 13)}${esc(flow.error)}</div>`;
  return "";
}

function targetOptions() {
  return state.targets ? [...state.targets.values()].map((t) => `<option value="${esc(t.id)}">${esc(t.name)} ${esc(t.version)}</option>`).join("") : "";
}

function previewHtml(flow, p) {
  const pkg = flow.pkg;
  const info = pkg.info;
  const dis = flow.busy ? " disabled" : "";
  const same = p && pkg.hash === p.hash;
  const target = flow.target ? p.target : pkg.target ?? info.target;
  const t = target && state.targets?.get(target);
  const dupe = !p && state.patches.find((x) => x.hash === pkg.hash);
  const notes = [];
  notes.push(["warn", "패치 스크립트는 이 컴퓨터에서 node로 실행되어 파일을 고칩니다. 믿을 수 있는 출처인지, 아래 코드를 꼭 확인해 주십시오."]);
  if (dupe) notes.push(["error", `같은 코드의 패치가 이미 있습니다: ${dupe.name}`]);
  if (!p && target && state.targets && !t) notes.push(["warn", `대상 패키지 "${target}"이(가) 설치되어 있지 않습니다. 설치한 뒤 실행해 주십시오.`]);
  if (!p && !target) notes.push(["hint", "코드에서 대상 패키지를 찾지 못했습니다. 지정해 두면 적용 여부와 업데이트 후 재실행 필요를 자동으로 확인합니다."]);
  if (!info.restore) notes.push(["hint", "--restore(되돌리기)를 지원하지 않는 패치로 보입니다."]);
  if (flow.mode === "link" && !same) notes.push(["hint", "지금 코드와 다릅니다. 연결만 하고 코드는 바꾸지 않습니다. 연결 후 업데이트로 표시됩니다."]);
  if (flow.mode === "link" && same) notes.push(["hint", "지금 코드와 같습니다. 연결만 하고 코드는 바꾸지 않습니다."]);
  if (flow.mode === "update" && p?.applied) notes.push(["hint", "업데이트하면 \"다시 실행 필요\"로 바뀝니다. 마리나라를 끄고 실행 파일을 다시 돌려 주십시오."]);
  if (flow.mode === "update" && same) notes.push(["hint", "이미 같은 코드입니다."]);
  const primary =
    flow.mode === "link"
      ? `<button type="button" class="pmgr-btn is-primary" data-act="flow-link"${dis}>${icon("link", 13)}이 파일 연결</button>`
      : `<button type="button" class="pmgr-btn is-primary" data-act="flow-apply"${dis || (dupe || same ? " disabled" : "")}>${p ? "업데이트 받기" : "패치 추가"}</button>`;
  const src = pkg.source;
  const lines = pkg.text.split("\n").length;
  return `
        <div class="pmgr-flow-title"><strong>${esc(p ? p.name : info.name)}</strong><span class="pmgr-ver">${esc(pkg.file)}</span></div>
        <div class="pmgr-flow-meta">${src.kind === "github" ? `${icon("github", 13)}<span>${esc(src.repo)}</span><span class="pmgr-mono">${esc(src.path)} @ ${esc(src.ref.slice(0, 10))}</span>` : `${icon("fileCode", 13)}<span>${esc(src.fileName)}</span>`}</div>
        <div class="pmgr-flow-caps"><span class="pmgr-badge">${kb(pkg.size)} · ${lines}줄</span><span class="pmgr-badge pmgr-mono">sha256 ${esc(shortHash(pkg.hash))}</span>${info.restore ? `<span class="pmgr-badge">${icon("undo", 11)}되돌리기 지원</span>` : ""}</div>
        ${info.description ? `<p class="pmgr-flow-desc">${esc(info.description)}</p>` : ""}
        ${
          !p
            ? `<label class="pmgr-flow-input">${icon("package", 14)}<input data-flow-target list="pmgr-targets" value="${esc(target)}" placeholder="대상 패키지 ID (예: gacha-forge)" spellcheck="false" autocomplete="off"></label>
               <datalist id="pmgr-targets">${targetOptions()}</datalist>
               ${t ? `<p class="pmgr-hint">${esc(t.name)} ${esc(t.version)} 설치됨</p>` : ""}
               <label class="pmgr-opt"><input type="checkbox" data-flow-applied${flow.alreadyApplied ? " checked" : ""}><span><strong>이미 적용해 두었습니다</strong><span>예전에 직접 node로 실행해 둔 패치라면 켜 주십시오. 지금 설치 상태를 적용됨으로 기록합니다.</span></span></label>`
            : ""
        }
        ${notes.map(([kind, text]) => `<div class="pmgr-flow-note is-${kind}">${esc(text)}</div>`).join("")}
        <details class="pmgr-code" data-code="flow"><summary>코드 보기 · ${esc(pkg.file)}</summary><pre>${esc(pkg.text)}</pre></details>
        <div class="pmgr-flow-actions">${primary}<button type="button" class="pmgr-btn is-ghost" data-act="flow-cancel">취소</button></div>`;
}

function renderFlow(flow) {
  const p = flow.target ? patchOf(flow.target) : null;
  const dis = flow.busy ? " disabled" : "";
  const cancel = `<button type="button" class="pmgr-btn is-ghost" data-act="flow-cancel">취소</button>`;
  let body = "";
  if (flow.step === "url") {
    const local = flow.target
      ? ""
      : `<div class="pmgr-flow-local">
                <button type="button" class="pmgr-btn" data-act="import-file" title=".mjs, .js, .cjs · 여러 개 골라도 됩니다"${dis}>${icon("fileCode", 13)}파일에서</button>
                <button type="button" class="pmgr-btn" data-act="import-folder" title="폴더 안의 패치 스크립트를 모두 찾습니다"${dis}>${icon("folder", 13)}폴더에서</button>
            </div>
            <p class="pmgr-hint">이미 받아 둔 패치가 있으면 그 폴더를 고르십시오(예: Downloads 안의 확장 폴더). patch/ 폴더의 스크립트를 모두 찾아 한 번에 추가합니다.</p>
            <div class="pmgr-flow-or">또는 GitHub 저장소</div>`;
    body = `${local}
            <label class="pmgr-flow-input">${icon("github", 14)}<input data-flow-url value="${esc(flow.url)}" placeholder="https://github.com/소유자/저장소" spellcheck="false" autocomplete="off"></label>
            <div class="pmgr-flow-actions"><button type="button" class="pmgr-btn is-primary" data-act="flow-find"${dis}>${icon("search", 13)}패치 찾기</button>${flow.target ? cancel : ""}</div>
            <p class="pmgr-hint">공개 저장소만 지원합니다. patch/ 폴더의 스크립트나 이름에 patch가 들어간 .mjs를 찾습니다. 파일 주소(…/blob/main/patch/apply-patch.mjs)를 넣어도 됩니다.</p>`;
  } else if (flow.step === "choose") {
    const snap = flow.snapshot;
    body = `
            <div class="pmgr-flow-meta">${icon("github", 13)}<span>${esc(snap.repo)}</span><span class="pmgr-mono">${esc(snap.sha.slice(0, 10))}</span></div>
            <label class="pmgr-select is-block"><select data-flow-choice aria-label="패치 스크립트">${snap.choices.map((c, i) => `<option value="${i}"${i === flow.choiceIndex ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
            <div class="pmgr-flow-actions"><button type="button" class="pmgr-btn is-primary" data-act="flow-load"${dis}>내용 확인</button><button type="button" class="pmgr-btn is-ghost" data-act="flow-back">다른 주소</button>${flow.target ? cancel : ""}</div>`;
  } else if (flow.step === "preview") {
    body = previewHtml(flow, p);
  } else if (flow.step === "multi") {
    const ok = flow.items.filter((x) => x.pkg && !x.dupe);
    const picked = ok.filter((x) => x.checked).length;
    body = `
            <div class="pmgr-side-title">찾은 패치 · ${flow.items.length}개</div>
            <div class="pmgr-pick-list">${flow.items
              .map((x, i) => {
                const info = x.pkg?.info;
                const state2 = x.error ? `<span class="pmgr-err">${esc(x.error)}</span>` : x.dupe ? `<span class="pmgr-hint">이미 있음: ${esc(x.dupe)}</span>` : "";
                return `<label class="pmgr-pick${x.pkg && !x.dupe ? "" : " is-off"}">
                    <input type="checkbox" data-pick="${i}"${x.checked ? " checked" : ""}${x.pkg && !x.dupe ? "" : " disabled"}>
                    <span class="pmgr-pick-main"><strong>${esc(info?.name || x.path)}</strong><span class="pmgr-mono">${esc(x.path)}</span>${state2}</span>
                    ${info ? `<span class="pmgr-chip">${icon("package", 11)}${esc(info.target || "대상 미지정")}</span>` : ""}
                </label>`;
              })
              .join("")}</div>
            <div class="pmgr-flow-note is-warn">패치 스크립트는 이 컴퓨터에서 node로 실행되어 파일을 고칩니다. 믿을 수 있는 것만 추가해 주십시오. 추가한 뒤 상세 패널에서 코드를 볼 수 있습니다.</div>
            <div class="pmgr-flow-note is-hint">예전에 이미 적용해 둔 패치라면, 추가한 뒤 [검사]에서 마리나라 data 폴더를 고르면 들어 있는 패치를 찾아 적용됨으로 표시합니다.</div>
            <div class="pmgr-flow-actions"><button type="button" class="pmgr-btn is-primary" data-act="flow-add-picked"${dis || (picked ? "" : " disabled")}>${icon("plus", 13)}${picked}개 추가</button><button type="button" class="pmgr-btn is-ghost" data-act="flow-cancel">취소</button></div>`;
  } else if (flow.step === "done") {
    const ids = flow.resultIds || [flow.resultId];
    body = `
            <div class="pmgr-flow-note is-ok">${icon("circleCheck", 14)}패치 ${ids.length}개를 추가했습니다. 실행 목록에 들어갔습니다.</div>
            <div class="pmgr-flow-actions">
                <button type="button" class="pmgr-btn is-primary" data-act="run-open">${icon("terminal", 13)}실행 파일 받으러 가기</button>
                <button type="button" class="pmgr-btn" data-act="scan-open">${icon("folderSearch", 13)}이미 적용됐는지 검사</button>
                ${ids.length === 1 ? `<button type="button" class="pmgr-btn" data-act="flow-show" data-id="${esc(ids[0])}">이 패치 보기</button>` : ""}
                <button type="button" class="pmgr-btn is-ghost" data-act="flow-again">다른 패치 추가</button>
            </div>`;
  }
  return `<div class="pmgr-flow">${body}${flowStatusHtml(flow)}</div>`;
}

function addViewHtml() {
  return `<div class="pmgr-toolbar">
            <button type="button" class="pmgr-btn is-ghost" data-act="view-close">${icon("arrowLeft", 13)}목록으로</button>
            <strong class="pmgr-toolbar-title">${icon("plus", 14)}패치 추가</strong>
        </div>
        <div class="pmgr-scroll"><div class="pmgr-flow-wrap">${renderFlow(state.flow)}</div></div>`;
}

// ----- 실행 화면 -----

function runViewHtml() {
  const mode = state.runMode;
  const list = runList();
  const runnable = mode === "restore" ? list.filter((p) => p.restore) : list;
  const excluded = state.patches.length - list.length;
  const rows = list
    .map((p, i) => {
      const key = statusOf(p);
      const skip = mode === "restore" && !p.restore;
      return `<div class="pmgr-run-row${skip ? " is-skip" : ""}">
            <span class="pmgr-order">${i + 1}</span>
            <div class="pmgr-run-main"><strong>${esc(p.name)}</strong><span>${esc(p.file)}${p.target ? ` · ${esc(targetLabel(p.target))}` : ""}${skip ? " · 되돌리기 없음, 건너뜀" : ""}</span></div>
            <span class="pmgr-status is-${STATUS[key].css}">${icon(STATUS[key].icon, 11)}${STATUS[key].label}</span>
            <span class="pmgr-run-tools">
                <button type="button" class="pmgr-act" data-act="move-up" data-id="${esc(p.id)}"${i ? "" : " disabled"} title="앞으로" aria-label="앞으로">${icon("chevronUp", 13)}</button>
                <button type="button" class="pmgr-act" data-act="move-down" data-id="${esc(p.id)}"${i < list.length - 1 ? "" : " disabled"} title="뒤로" aria-label="뒤로">${icon("chevronDown", 13)}</button>
                <button type="button" class="pmgr-act" data-act="include" data-id="${esc(p.id)}" title="실행 목록에서 빼기" aria-label="실행 목록에서 빼기">${icon("x", 13)}</button>
            </span>
        </div>`;
    })
    .join("");
  const stale = list.filter((p) => ["stale", "off"].includes(statusOf(p))).length;
  const port = localPort();
  const cmd = runCommand();
  return `<div class="pmgr-toolbar">
            <button type="button" class="pmgr-btn is-ghost" data-act="view-close">${icon("arrowLeft", 13)}목록으로</button>
            <strong class="pmgr-toolbar-title">${icon("terminal", 14)}패치 실행</strong>
        </div>
        <div class="pmgr-scroll"><div class="pmgr-flow-wrap pmgr-settings">
            ${runBanner()}
            <div class="pmgr-seg pmgr-run-mode" role="group" aria-label="실행 방식">
                <button type="button" class="${mode === "apply" ? "is-active" : ""}" data-act="run-mode" data-v="apply">${icon("wrench", 13)}적용</button>
                <button type="button" class="${mode === "restore" ? "is-active" : ""}" data-act="run-mode" data-v="restore">${icon("undo", 13)}되돌리기</button>
            </div>
            <div class="pmgr-side-title">실행 목록 · ${runnable.length}개${mode === "apply" && stale ? ` (적용 필요 ${stale}개)` : ""}</div>
            ${rows || `<p class="pmgr-hint">실행 목록이 비어 있습니다. 패치 카드의 전원 버튼으로 넣을 수 있습니다.</p>`}
            ${excluded ? `<p class="pmgr-hint">실행 목록에서 뺀 패치 ${excluded}개는 들어가지 않습니다.</p>` : ""}
            <p class="pmgr-hint">${mode === "restore" ? "되돌리기는 목록을 거꾸로, 뒤에서부터 실행합니다." : "위에서부터 순서대로 실행합니다. 같은 파일을 고치는 패치는 순서가 중요할 수 있습니다."}</p>
            <label class="pmgr-flow-input">${icon("folder", 14)}<input data-pref-text="dataDir" value="${esc(state.prefs.dataDir)}" placeholder="마리나라 data 폴더 (비우면 실행한 폴더에서 찾음)" spellcheck="false" autocomplete="off"></label>
            <div class="pmgr-flow-actions">
                <button type="button" class="pmgr-btn is-primary" data-act="run-download"${runnable.length ? "" : " disabled"}>${icon("download", 13)}${mode === "restore" ? "되돌리기 파일 받기" : "실행 파일 받기"}</button>
            </div>
            ${autoSectionHtml(mode, runnable)}
            <div class="pmgr-side-title">직접 실행 (도우미 없이)</div>
            <p class="pmgr-hint">이 관리자는 마리나라 안에서 돌아가므로 마리나라가 켜져 있을 때 씁니다. 하지만 패치는 마리나라가 꺼진 동안에 들어가야 합니다(켜져 있으면 마리나라가 설치 기록을 옛 해시로 덮어씁니다). 그래서 파일은 지금 받고, 실행은 마리나라를 끌 때 합니다.</p>
            <ol class="pmgr-steps">
                <li><strong>${esc(BUNDLE_NAME)}</strong>을(를) 받습니다(마리나라가 켜진 지금). 패치가 모두 이 파일 하나에 들어 있습니다.</li>
                <li>${state.prefs.dataDir.trim() ? "아무 폴더에서나" : "마리나라 엔진 폴더에서"} 터미널을 열고 실행합니다(Node.js 필요).${mode === "restore" ? " 받은 파일은 되돌리기용이라 따로 --restore를 붙이지 않아도 됩니다." : ""}
                    <div class="pmgr-cmd"><code>${esc(cmd)}</code><button type="button" class="pmgr-icon-btn" data-act="copy" data-v="${esc(cmd)}" title="복사" aria-label="명령 복사">${icon("copy", 13)}</button></div>
                    <span class="pmgr-hint">받은 파일이 다른 폴더에 있으면 그 경로를 적습니다. 예: node "C:\\Users\\나\\Downloads\\${esc(BUNDLE_NAME)}" · 같은 이름이 있으면 브라우저가 "(1)"을 붙일 수 있습니다.</span></li>
                <li><strong>마리나라를 끕니다</strong>(런처 창을 닫거나 Ctrl+C). ${state.prefs.portCheck ? "마리나라가 아직 켜져 있으면 실행 파일이 기다리다가, 꺼진 것을 확인하면(8초 동안 꺼져 있으면) 바로 패치합니다. 그러니 2번과 3번은 순서가 바뀌어도 됩니다." : "기다리기를 꺼 두었으므로, 마리나라를 먼저 끈 뒤 2번을 실행해 주십시오."} 설정 → 고급의 <strong>서버 재시작</strong>은 끄자마자 바로 다시 켜서 패치할 틈이 없으므로 이 용도로는 쓸 수 없습니다.</li>
                <li>터미널에 "결과: 성공"이 뜨면 마리나라를 다시 켜고 이 관리자를 엽니다. 설치 기록의 해시가 바뀐 것을 보고 적용 여부를 자동으로 표시합니다.</li>
            </ol>
            <p class="pmgr-hint">그 밖의 옵션: --list(목록만 보기), --no-wait(켜져 있으면 기다리지 않고 그만두기), --force(켜져 있어도 바로 실행, 권장하지 않음), 끝에 data 폴더 경로.</p>
        </div></div>`;
}

// ----- 자동 적용 (서버 도우미) -----

function autoSectionHtml(mode, runnable) {
  const h = state.helper;
  const code = helperCode();
  const auto = state.auto || {};
  const busy = auto.busy;
  const startCmd = `node ${HELPER_NAME}`;
  const result = h?.result && (!auto.jobId || h.doneJob === auto.jobId) ? h.result : null;
  const resultHtml = result
    ? `<div class="pmgr-flow-note is-${result.ok ? "ok" : "error"}">${icon(result.ok ? "circleCheck" : "circleX", 13)}<span>마지막 자동 적용 · ${fmtTime(result.at)} · ${result.ok ? "성공" : "실패"}${result.items?.length ? ` · ${result.items.map((x) => `${esc(x.name)} ${x.ok ? "✓" : "✗"}`).join(", ")}` : ""}</span></div>
       ${result.log ? `<details class="pmgr-code"><summary>도우미 기록 보기</summary><pre>${esc(result.log)}</pre></details>` : ""}`
    : "";
  const guide = `<ol class="pmgr-steps">
        <li><button type="button" class="pmgr-btn" data-act="helper-download">${icon("download", 13)}${esc(HELPER_NAME)} 받기</button> (한 번만 하면 됩니다)</li>
        <li>마리나라가 돌아가는 컴퓨터의 <strong>마리나라 엔진 폴더</strong>(packages 폴더가 있는 곳)에 넣습니다. SSH로 쓰는 서버나 호스팅 서버라면 그 서버로 올립니다(예: scp, SFTP).</li>
        <li>마리나라를 평소 방법 대신 이 명령으로 켭니다. 처음 켜면 터미널에 <strong>연결 코드</strong>가 나옵니다.
            <div class="pmgr-cmd"><code>${esc(startCmd)}</code><button type="button" class="pmgr-icon-btn" data-act="copy" data-v="${esc(startCmd)}" title="복사" aria-label="명령 복사">${icon("copy", 13)}</button></div>
            <span class="pmgr-hint">서버에서 systemd·pm2 같은 서비스로 돌린다면, 시작 명령(pnpm start)을 이 명령으로 바꾸면 됩니다. 업데이트·빌드는 평소처럼 런처나 pnpm으로 하고, 켜는 것만 도우미로 합니다. 연결 코드를 잊었으면 <code>${esc(startCmd)} --code</code>.</span></li>
        <li>연결 코드를 위의 "연결 코드" 칸에 넣습니다. 이제부터는 이 화면의 [자동 적용]만 누르면 됩니다.</li>
    </ol>
    <p class="pmgr-hint">Docker로 돌리는 마리나라는 재시작이 컨테이너째 다시 켜지는 방식이라 도우미를 쓸 수 없습니다. 컨테이너를 멈추고 같은 data 볼륨으로 실행 파일을 돌려 주십시오.</p>`;
  return `<div class="pmgr-side-title">자동 적용 (서버 도우미)</div>
        <p class="pmgr-hint">패치는 마리나라가 꺼져 있을 때만 넣을 수 있습니다. 서버 컴퓨터에 작은 도우미를 한 번 깔아 두면, [자동 적용]을 누를 때 도우미가 마리나라를 정상 재시작하면서 꺼진 그 틈에 패치를 넣고 다시 켭니다. 터미널을 다시 열지 않아도 되고, 집 컴퓨터든 SSH 서버든 호스팅 서버든 똑같이 됩니다.</p>
        <div class="pmgr-opt is-static pmgr-helper">
            <span><strong>${h?.version ? `${icon("circleCheck", 13)} 도우미 확인됨` : `${icon("circle", 13)} 도우미가 아직 연결되지 않았습니다`}</strong>
            <span>${h?.version ? `${esc(h.engine || "")} · 마지막 신호 ${fmtTime(h.at)} · v${esc(h.version)}` : "도우미로 마리나라를 켜면 몇 초 뒤 여기에 표시됩니다. 표시가 없어도 연결 코드만 맞으면 자동 적용을 시도할 수 있습니다."}</span></span>
            ${
              code
                ? `<div class="pmgr-gh-actions"><span class="pmgr-hint">${icon("check", 12)} 연결 코드가 이 브라우저에 저장되어 있습니다.</span><button type="button" class="pmgr-btn is-ghost" data-act="helper-code-clear">코드 바꾸기</button></div>`
                : `<label class="pmgr-flow-input">${icon("link", 14)}<input data-helper-code placeholder="연결 코드 (예: 1a2b-3c4d-…)" spellcheck="false" autocomplete="off"></label>
                   <div class="pmgr-gh-actions"><button type="button" class="pmgr-btn" data-act="helper-code-save">연결 코드 저장</button><span class="pmgr-hint">이 브라우저에만 저장되고 서버에는 보내지 않습니다.</span></div>`
            }
            <div class="pmgr-flow-actions">
                <button type="button" class="pmgr-btn is-primary" data-act="auto-run"${busy || !code || !runnable.length ? " disabled" : ""}>${icon(busy ? "loader" : mode === "restore" ? "undo" : "wrench", 13)}${busy ? esc(busy) : `${mode === "restore" ? "자동으로 되돌리기" : "자동 적용"} · ${runnable.length}개`}</button>
            </div>
            ${auto.error ? `<div class="pmgr-flow-status is-error">${icon("circleX", 13)}${esc(auto.error)}</div>` : ""}
            ${busy ? '<p class="pmgr-hint">마리나라가 잠깐 꺼졌다 켜지는 동안 화면 연결이 끊길 수 있습니다. 페이지를 새로 고쳐도 패치는 계속되고, 다시 열면 결과가 보입니다.</p>' : ""}
            ${resultHtml}
        </div>
        ${h?.version ? `<details class="pmgr-code"><summary>도우미 설치 방법</summary><div class="pmgr-guide">${guide}</div></details>` : guide}`;
}

// ----- 검사 화면: 들어 있는 패치 · 백업본 -----

function scanViewHtml() {
  const scan = state.scan;
  const busy = state.scanBusy;
  const remote = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const name = (id) => patchOf(id)?.name || id;
  let body = "";
  if (scan) {
    const r = state.scanResult;
    const summary = r
      ? [
          r.runtimeAdded?.length && `런타임 패치 ${r.runtimeAdded.length}개를 관리자에 추가: ${r.runtimeAdded.map(name).join(", ")}`,
          r.scriptsAdded?.length && `파일 패치 ${r.scriptsAdded.length}개를 관리자에 추가: ${r.scriptsAdded.map(name).join(", ")}`,
          r.found.length && `적용됨으로 표시: ${r.found.map(name).join(", ")}`,
          r.gone.length && `흔적이 없어 적용 기록을 지움: ${r.gone.map(name).join(", ")}`,
        ].filter(Boolean)
      : [];
    const relevant = scan.packages.filter((pkg) => pkg.markers.length || state.patches.some((p) => p.target === pkg.id));
    const pkgRows = relevant
      .map((pkg) => {
        const mine = state.patches.filter((p) => p.target === pkg.id);
        const unknown = unknownMarkers(pkg);
        const lines = mine.map((p) => {
          const names = markersOf(p);
          if (!names.length) return `<li><span class="pmgr-status is-off">${icon("circle", 11)}알 수 없음</span>${esc(p.name)} <span class="pmgr-hint">· 표식을 남기지 않는 패치라 확인할 수 없습니다</span></li>`;
          const present = names.some((n) => pkg.markers.includes(n));
          return `<li><span class="pmgr-status is-${present ? "on" : "off"}">${icon(present ? "circleCheck" : "circle", 11)}${present ? "들어 있음" : "없음"}</span>${esc(p.name)}</li>`;
        });
        for (const n of unknown) lines.push(`<li><span class="pmgr-status is-pending">${icon("shieldAlert", 11)}관리 안 함</span><span class="pmgr-mono">${esc(n)}</span> <span class="pmgr-hint">· 이 관리자에 없는 패치입니다. 그 패치 파일을 [패치 추가]로 불러오면 연결됩니다.</span></li>`);
        return `<div class="pmgr-scan-pkg"><strong>${icon("package", 13)}${esc(pkg.name)} <span class="pmgr-ver">${esc(pkg.version)}</span></strong><ul>${lines.join("") || '<li class="pmgr-hint">패치 흔적이 없습니다.</li>'}</ul></div>`;
      })
      .join("");
    const total = scan.backups.reduce((n, b) => n + b.size, 0);
    const confirmAll = state.confirmBackup === "__all";
    const backupRows = scan.backups
      .map((b) => {
        const confirming = state.confirmBackup === b.path;
        return `<div class="pmgr-run-row">
            <div class="pmgr-run-main"><strong class="pmgr-mono">${esc(b.path.split("/").pop())}${b.dir ? "/ (폴더)" : ""}</strong><span>${esc(b.scope === "engine" ? b.path.slice("engine/".length) : b.path)} · ${kb(b.size)} · ${fmtDate(b.modified)}${b.scope === "engine" ? ` · ${esc(b.group)}` : b.current ? "" : " · 지금 쓰지 않는 옛 버전"}</span></div>
            ${scan.writable ? `<button type="button" class="pmgr-btn${confirming ? " is-danger" : " is-ghost"}" data-act="backup-del" data-v="${esc(b.path)}"${busy ? " disabled" : ""}>${icon("trash", 13)}${confirming ? "정말 삭제" : "삭제"}</button>` : ""}
        </div>`;
      })
      .join("");
    body = `
            ${summary.length ? `<div class="pmgr-flow-note is-ok">${icon("circleCheck", 14)}<span>${summary.map(esc).join("<br>")}</span></div>` : ""}
            <p class="pmgr-hint">${fmtTime(scan.at)} 검사 · 설치 패키지 ${scan.packages.length}개</p>
            ${runtimeSectionHtml(scan)}
            ${
              scan.scripts?.length
                ? `<div class="pmgr-side-title">애드온 폴더의 파일 패치 스크립트 · ${scan.scripts.length}개</div>
                   <ul class="pmgr-plain-list">${scan.scripts.map((x) => `<li><span class="pmgr-mono">${esc(x.path)}</span> <span class="pmgr-hint">· 관리자 목록에 있음</span></li>`).join("")}</ul>`
                : ""
            }
            <div class="pmgr-side-title">설치 패키지 속 패치</div>
            ${pkgRows || '<p class="pmgr-hint">패치가 들어 있는 패키지가 없습니다.</p>'}
            <div class="pmgr-side-title">패치 백업본 · ${scan.backups.length}개${scan.backups.length ? ` · ${kb(total)}` : ""}</div>
            ${
              scan.backups.length
                ? `<p class="pmgr-hint">패치를 깔거나 고칠 때 남은 옛 사본입니다: 패키지 원본(server.mjs.gmm-backup 등), .env 사본(.env.before-…), 애드온 폴더의 .bak · .before-… · 옛 버전 사본, .prev · .backup-… 폴더. 지금 쓰는 파일은 목록에 넣지 않으므로 지워도 마리나라와 패치는 그대로 동작합니다. 다만 되돌릴 때 쓸 원본이 없어지니, 되돌릴 일이 없을 때 지우세요.</p>
                   ${backupRows}
                   <div class="pmgr-flow-actions">${
                     scan.writable
                       ? `<button type="button" class="pmgr-btn is-danger" data-act="backup-del-all"${busy ? " disabled" : ""}>${icon("trash", 13)}${confirmAll ? `정말 ${scan.backups.length}개 모두 삭제` : "백업본 모두 삭제"}</button>`
                       : `<button type="button" class="pmgr-btn is-primary" data-act="backup-clean-file">${icon("download", 13)}정리 파일 받기</button>`
                   }</div>
                   ${
                     scan.writable
                       ? `<p class="pmgr-hint">${scan.via === "helper" ? "서버에 있는 도우미가 지웁니다. 마리나라가 켜져 있어도 됩니다." : "삭제할 때 브라우저가 이 폴더를 수정해도 되는지 한 번 묻습니다."}</p>`
                       : `<p class="pmgr-hint">이 브라우저는 폴더 속 파일을 직접 지울 수 없습니다(크롬·엣지는 가능). 정리 파일을 받아 마리나라 엔진 폴더에서 실행해 주십시오. 마리나라가 켜져 있어도 됩니다.</p>
                          <div class="pmgr-cmd"><code>node "marinara-clean-backups.mjs"</code><button type="button" class="pmgr-icon-btn" data-act="copy" data-v='node "marinara-clean-backups.mjs"' title="복사" aria-label="명령 복사">${icon("copy", 13)}</button></div>`
                   }`
                : '<p class="pmgr-hint">백업본이 없습니다.</p>'
            }`;
  }
  return `<div class="pmgr-toolbar">
            <button type="button" class="pmgr-btn is-ghost" data-act="view-close">${icon("arrowLeft", 13)}목록으로</button>
            <strong class="pmgr-toolbar-title">${icon("folderSearch", 14)}설치된 패치 · 백업본</strong>
        </div>
        <div class="pmgr-scroll"><div class="pmgr-flow-wrap pmgr-settings">
            <p class="pmgr-hint">마리나라에 깔린 패치를 모두 찾아 관리자에 반영합니다. .env의 NODE_OPTIONS로 불러오는 <strong>런타임 패치</strong>(.cjs)와, 패키지 파일을 고치는 <strong>파일 패치</strong>(patch/apply-patch.mjs 같은 것)가 들어 있는지, 그리고 남은 백업본을 찾습니다. 서버의 파일을 읽어야 하므로 도우미로 검사하는 것을 권합니다.</p>
            <div class="pmgr-flow-actions">
                <button type="button" class="pmgr-btn${remote ? " is-primary" : ""}" data-act="scan-helper"${busy || !helperCode() ? " disabled" : ""}>${icon(busy ? "loader" : "terminal", 13)}설치된 패치 찾기 (도우미)</button>
                <button type="button" class="pmgr-btn${remote ? "" : " is-primary"}" data-act="scan-pick"${busy ? " disabled" : ""}>${icon(busy ? "loader" : "folderSearch", 13)}이 컴퓨터에서 폴더 고르기</button>
                ${typeof window.showDirectoryPicker === "function" ? `<button type="button" class="pmgr-btn is-ghost" data-act="scan-pick-plain"${busy ? " disabled" : ""} title="브라우저가 '이 폴더를 열 수 없음'이라고 할 때">${icon("folder", 13)}다른 방식으로 고르기</button>` : ""}
            </div>
            ${typeof window.showDirectoryPicker === "function" ? '<p class="pmgr-hint">크롬·엣지가 "시스템 파일이 포함되어 있어 열 수 없음"이라고 하면(마리나라가 AppData 안에 있을 때 등) [다른 방식으로 고르기]를 쓰세요. 그 방식은 읽기만 되므로 백업본은 정리 파일이나 도우미로 지웁니다. 브라우저가 파일을 “업로드”할지 물어도 이 브라우저 안에서만 읽습니다.</p>' : ""}
            ${busy ? `<p class="pmgr-hint">${icon("loader", 12)} ${esc(busy)}</p>` : ""}
            <p class="pmgr-hint"><strong>SSH·호스팅 서버</strong>: 브라우저가 서버의 폴더를 열 수 없으므로, 서버에 깐 도우미가 대신 검사하고 백업본도 지웁니다. ${helperCode() ? "" : "먼저 실행 → 자동 적용에서 도우미를 깔고 연결 코드를 넣어 주십시오."}<br><strong>이 컴퓨터에서 돌리는 마리나라</strong>: 마리나라 엔진 폴더나 그 안의 packages/server/data를 고르면 됩니다. 파일은 이 브라우저 안에서만 읽습니다.${typeof window.showDirectoryPicker === "function" ? "" : " 이 브라우저는 폴더 속 파일을 모두 훑으므로 packages/server/data를 고르는 편이 빠릅니다."}</p>
            ${state.scanError ? `<div class="pmgr-flow-status is-error">${icon("circleX", 13)}${esc(state.scanError)}</div>` : ""}
            ${body}
        </div></div>`;
}

/** Runtime patches as the server loads them, with on/off and order to change (applied on the next start). */
function runtimeSectionHtml(scan) {
  if (!Array.isArray(scan.runtime)) {
    return '<div class="pmgr-side-title">런타임 패치 (NODE_OPTIONS)</div><p class="pmgr-hint">폴더로 검사하면 런타임 패치는 보이지 않습니다. [서버에서 검사 (도우미)]가 .env의 NODE_OPTIONS까지 읽습니다.</p>';
  }
  const items = runtimeItems();
  const outside = scan.runtime.filter((r) => !r.inEngine);
  const rows = items
    .map((p, i) => {
      const key = statusOf(p);
      const targets = (p.rt.targets || []).map((t) => t.name + " " + t.wants.join("/")).join(", ");
      return `<div class="pmgr-run-row${p.include ? "" : " is-skip"}">
            <span class="pmgr-order">${i + 1}</span>
            <div class="pmgr-run-main"><strong>${esc(p.name)}</strong><span>${esc(p.rt.path)}${targets ? ` · ${esc(targets)}` : ""}${(p.rt.configs || []).length ? ` · 설정 ${p.rt.configs.length}개` : ""}</span></div>
            <span class="pmgr-status is-${STATUS[key].css}" title="${esc(statusInfo(p).reason)}">${icon(STATUS[key].icon, 11)}${esc(labelOf(p))}</span>
            <span class="pmgr-run-tools">
                <button type="button" class="pmgr-act" data-act="move-up" data-id="${esc(p.id)}"${i ? "" : " disabled"} title="먼저 불러오기" aria-label="앞으로">${icon("chevronUp", 13)}</button>
                <button type="button" class="pmgr-act" data-act="move-down" data-id="${esc(p.id)}"${i < items.length - 1 ? "" : " disabled"} title="나중에 불러오기" aria-label="뒤로">${icon("chevronDown", 13)}</button>
                <button type="button" class="pmgr-act${p.include ? " is-on" : ""}" data-act="include" data-id="${esc(p.id)}" title="${p.include ? "끄기" : "켜기"}" aria-label="${p.include ? "끄기" : "켜기"}">${icon(p.include ? "power" : "powerOff", 13)}</button>
            </span>
        </div>`;
    })
    .join("");
  return `<div class="pmgr-side-title">런타임 패치 (NODE_OPTIONS 순서) · 켜짐 ${runtimeActual().length}개</div>
        <p class="pmgr-hint">마리나라가 켜질 때 위에서부터 불러옵니다. 서로 기대는 패치는 순서가 중요합니다(예: gf-featured는 gf-customizer 뒤). 켜기·끄기·순서를 바꾸면 [재시작해서 적용]으로 반영합니다.</p>
        ${runtimeBanner()}
        ${rows || '<p class="pmgr-hint">.env의 NODE_OPTIONS에 런타임 패치가 없습니다.</p>'}
        ${outside.length ? `<p class="pmgr-hint">엔진 폴더 밖이라 그대로 두는 것: ${outside.map((r) => esc(r.path)).join(", ")}</p>` : ""}`;
}

/** A scan the helper runs on the server; the result has the same shape as a folder scan. */
async function runHelperScan(kind = "scan", paths = []) {
  if (state.scanBusy) return;
  state.scanError = "";
  state.confirmBackup = null;
  state.scanBusy = kind === "clean" ? "도우미가 백업본을 지우는 중…" : "도우미가 서버를 검사하는 중…";
  renderMain();
  try {
    try {
      state.targets = await loadTargets();
    } catch {}
    const scan = await helperTask(kind, paths);
    await useDiscovery(scan);
    if (kind === "clean") notice(`백업본 ${scan.removed || 0}개를 지웠습니다.`);
  } catch (err) {
    state.scanError = err instanceof Error ? err.message : String(err);
  } finally {
    state.scanBusy = "";
    render();
  }
}

async function runScan(plain = false) {
  if (state.scanBusy) return;
  state.scanError = "";
  let src;
  try {
    src = await pickDataFolder(plain);
  } catch (err) {
    state.scanError = err instanceof Error ? err.message : String(err);
    return renderMain();
  }
  if (!src) return;
  state.scanBusy = "폴더를 읽는 중…";
  state.confirmBackup = null;
  renderMain();
  try {
    try {
      state.targets = await loadTargets();
    } catch {}
    state.scan = await scanDataFolder(src);
    state.scanResult = applyScan(state.scan);
  } catch (err) {
    state.scanError = err instanceof Error ? err.message : String(err);
  } finally {
    state.scanBusy = "";
    render();
  }
}

/** Two clicks: the first arms the button, the second deletes. */
async function deleteBackups(paths, key) {
  const scan = state.scan;
  if (!scan?.writable || state.scanBusy) return;
  if (state.confirmBackup !== key) {
    state.confirmBackup = key;
    marinara.clearTimeout(confirmTimer);
    confirmTimer = marinara.setTimeout(() => {
      state.confirmBackup = null;
      renderSoft();
    }, 4000);
    return renderMain();
  }
  state.confirmBackup = null;
  if (scan.via === "helper") return runHelperScan("clean", paths);
  // Asked straight from the click, while the browser still counts it as the user's own action.
  let allowed = false;
  try {
    allowed = await scan.src.allowWrite();
  } catch {}
  if (!allowed) return notice("폴더를 수정할 권한을 받지 못했습니다. 다시 눌러 허용하거나, 정리 파일을 써 주십시오.");
  state.scanBusy = "백업본을 지우는 중…";
  renderMain();
  let removed = 0;
  let failed = 0;
  for (const path of paths) {
    const b = scan.backups.find((x) => x.path === path);
    if (!b) continue;
    try {
      await b.entry.remove();
      scan.backups = scan.backups.filter((x) => x !== b);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  state.scanBusy = "";
  renderMain();
  notice(`백업본 ${removed}개를 지웠습니다.${failed ? ` ${failed}개는 지우지 못했습니다.` : ""}`);
}

// ----- 설정 · 백업 -----

function settingsViewHtml() {
  const prefs = state.prefs;
  return `<div class="pmgr-toolbar">
            <button type="button" class="pmgr-btn is-ghost" data-act="view-close">${icon("arrowLeft", 13)}목록으로</button>
            <strong class="pmgr-toolbar-title">${icon("settings", 14)}설정</strong>
        </div>
        <div class="pmgr-scroll"><div class="pmgr-flow-wrap pmgr-settings">
            <div class="pmgr-side-title">실행 파일</div>
            <div class="pmgr-opt is-static"><span><strong>마리나라 data 폴더</strong><span>실행 파일에 넣어 둘 경로입니다. 비우면 실행한 폴더 기준으로 packages/server/data, data 순서로 찾습니다.</span></span>
                <label class="pmgr-flow-input">${icon("folder", 14)}<input data-pref-text="dataDir" value="${esc(prefs.dataDir)}" placeholder="예: C:\\Marinara-Engine\\packages\\server\\data" spellcheck="false" autocomplete="off"></label>
            </div>
            <label class="pmgr-opt">
                <input type="checkbox" data-pref="portCheck"${prefs.portCheck ? " checked" : ""}>
                <span><strong>마리나라가 꺼질 때까지 기다렸다가 패치</strong><span>실행 파일을 돌렸을 때 마리나라가 아직 켜져 있으면, 바로 패치하지 않고 마리나라를 끌 때까지 기다렸다가 패치합니다. 켜짐 여부는 data 폴더의 실행 표시(.writer-lease)와, 이 컴퓨터(localhost)에서 쓸 때는 포트로 확인합니다. 서버 재시작처럼 잠깐 꺼졌다 바로 켜지는 경우에는 패치하지 않고 계속 기다립니다. 이 옵션을 끄면 확인 없이 바로 패치하므로, 마리나라를 먼저 끈 뒤 실행해야 합니다.</span></span>
            </label>
            <div class="pmgr-side-title">관리자 백업</div>
            <div class="pmgr-opt is-static">
                <span><strong>백업 파일</strong><span>패치 코드·출처·적용 기록·그룹·태그·메모·설정을 파일 하나로 저장하거나 불러옵니다.</span></span>
                <div class="pmgr-backup-actions">
                    <button type="button" class="pmgr-btn" data-act="backup-export">${icon("download", 13)}백업 받기</button>
                    <button type="button" class="pmgr-btn" data-act="backup-import">${icon("upload", 13)}백업 불러오기</button>
                </div>
                ${backupPreviewHtml()}
            </div>
        </div></div>`;
}

function backupPreviewHtml() {
  const p = state.backupPreview;
  if (!p) return "";
  return `<div class="pmgr-backup-preview">
            <strong>${esc(p.fileName)}</strong>
            <span>${p.savedAt ? `${fmtDate(p.savedAt)} 저장 · ` : ""}패치 ${p.data.patches.length}개 · 그룹 ${p.data.groups.length}개</span>
            <span>지금 관리자의 패치와 설정을 이 백업으로 바꿉니다.</span>
            <div class="pmgr-backup-actions">
                <button type="button" class="pmgr-btn is-primary" data-act="backup-apply">${icon("check", 13)}적용</button>
                <button type="button" class="pmgr-btn" data-act="backup-cancel">취소</button>
            </div>
        </div>`;
}

function exportBackup() {
  const d = new Date();
  const payload = { kind: BACKUP_KIND, version: 1, savedAt: d.toISOString(), patches: state.patches, scripts: state.scripts, groups: state.groups, prefs: state.prefs };
  saveFile(`patch-manager-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`, JSON.stringify(payload, null, 2), "application/json");
  notice("백업 파일을 내려받습니다.");
}

function pickFiles(accept, { multiple = false, folder = false } = {}, onPick) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  if (folder) input.webkitdirectory = true;
  else if (!matchMedia("(pointer: coarse)").matches) input.accept = accept;
  input.addEventListener("change", () => input.files?.length && onPick([...input.files]), { once: true });
  input.click();
}
const pickFile = (accept, onPick) => pickFiles(accept, {}, (files) => onPick(files[0]));

async function readBackup(file) {
  let raw;
  try {
    if (file.size > GH_LIMIT) throw new Error();
    raw = JSON.parse(await file.text());
  } catch {
    return notice("백업 파일을 읽지 못했습니다.");
  }
  if (!isObj(raw) || raw.kind !== BACKUP_KIND) return notice("패치 관리자 백업 파일이 아닙니다.");
  const scripts = isObj(raw.scripts) ? raw.scripts : {};
  const patches = (Array.isArray(raw.patches) ? raw.patches : []).map(cleanPatch).filter((p) => p && hasCode(p, scripts));
  // A script is taken only when it still hashes to what the record says.
  for (const p of patches) if (!isRuntime(p) && (await sha256Hex(scripts[p.id])) !== p.hash) return notice(`백업 속 "${p.name}" 코드가 손상되었습니다.`);
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter((g) => isObj(g) && typeof g.id === "string" && g.id && typeof g.name === "string" && g.name);
  const groupIds = new Set(groups.map((g) => g.id));
  for (const p of patches) if (p.group && !groupIds.has(p.group)) p.group = null;
  const prefs = {};
  for (const [key, value] of Object.entries(isObj(raw.prefs) ? raw.prefs : {})) if (key in state.prefs && typeof value === typeof state.prefs[key]) prefs[key] = value;
  state.backupPreview = {
    fileName: file.name,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null,
    data: { patches, scripts: Object.fromEntries(patches.filter((p) => !isRuntime(p)).map((p) => [p.id, scripts[p.id]])), groups, prefs },
  };
  renderMain();
}

function applyBackup() {
  const b = state.backupPreview;
  if (!b) return;
  state.patches = b.data.patches;
  state.scripts = b.data.scripts;
  state.groups = b.data.groups;
  state.prefs = { ...state.prefs, ...b.data.prefs };
  state.lastRun = null;
  state.backupPreview = null;
  state.updates.clear();
  state.checked.clear();
  state.selectedId = null;
  resetFilter();
  scheduleSave(true);
  render();
  notice("백업을 적용했습니다.");
}

function renderMain() {
  const view = state.view === "add" && !state.flow ? "list" : state.view;
  const html = { settings: settingsViewHtml, run: runViewHtml, add: addViewHtml, scan: scanViewHtml }[view]?.() ?? null;
  if (html) {
    setHtml(refs.main, html);
    refs.main.dataset.view = view;
    return;
  }
  const keepScroll = refs.main.dataset.view === "list" ? refs.main.querySelector(".pmgr-scroll")?.scrollTop || 0 : 0;
  renderList();
  refs.main.dataset.view = "list";
  if (keepScroll) refs.main.querySelector(".pmgr-scroll").scrollTop = keepScroll;
}

// ----- 상세 -----

function sourceSectionHtml(p) {
  const flow = state.flow?.target === p.id ? state.flow : null;
  const src = p.source;
  const checking = state.checking.has(p.id);
  const id = esc(p.id);
  let label = `<span class="pmgr-field-label">${icon("github", 12)}GitHub</span>`;
  let inner;
  if (flow) {
    inner = renderFlow(flow);
  } else if (src.kind !== "github") {
    inner = `<div class="pmgr-hint">${icon("fileCode", 12)} 파일에서 추가함 · ${esc(src.fileName || p.file)}</div>
            <div class="pmgr-gh-actions">
                <button type="button" class="pmgr-btn" data-act="gh-connect" data-id="${id}">${icon("link", 13)}GitHub 파일 연결</button>
                <button type="button" class="pmgr-btn is-ghost" data-act="replace-file" data-id="${id}">${icon("upload", 13)}다른 파일로 교체</button>
            </div>
            <p class="pmgr-hint">연결하면 이 패치의 업데이트를 확인하고 받을 수 있습니다.</p>`;
  } else {
    label = `<a class="pmgr-field-label pmgr-gh-repo" href="https://github.com/${esc(src.repo)}/blob/${esc(src.ref)}/${esc(encodePath(src.path))}" target="_blank" rel="noopener noreferrer" title="GitHub에서 열기">${icon("github", 12)}<span>${esc(src.repo)}</span></a>`;
    inner = `
            <div class="pmgr-hint pmgr-mono">${esc(src.path)}${src.branch ? ` · ${esc(src.branch)}` : ""}</div>
            ${src.message ? `<div class="pmgr-gh-msg${state.updates.has(p.id) ? " is-update" : ""}">${esc(src.message)}</div>` : ""}
            <div class="pmgr-gh-actions">
                ${state.updates.has(p.id) ? `<button type="button" class="pmgr-btn is-primary" data-act="gh-view-update" data-id="${id}">${icon("arrowUp", 13)}업데이트 보기</button>` : ""}
                <button type="button" class="pmgr-btn" data-act="gh-check" data-id="${id}"${checking ? " disabled" : ""}>${icon(checking ? "loader" : "refresh", 13)}${checking ? "확인 중…" : "업데이트 확인"}</button>
                <button type="button" class="pmgr-btn is-ghost" data-act="gh-connect" data-id="${id}">주소 변경</button>
                <button type="button" class="pmgr-btn is-ghost" data-act="gh-unlink" data-id="${id}">${icon("unlink", 13)}연결 해제</button>
            </div>`;
  }
  return `<div class="pmgr-field pmgr-gh">${label}${inner}</div>`;
}

/** The target, applied record and source of a patch script. */
function scriptFieldsHtml(p, id, t) {
  return `
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("package", 12)}대상 패키지</span>
                <label class="pmgr-flow-input">${icon("package", 14)}<input data-detail-target="${id}" list="pmgr-targets-detail" value="${esc(p.target)}" placeholder="예: gacha-forge" spellcheck="false" autocomplete="off"></label>
                <datalist id="pmgr-targets-detail">${targetOptions()}</datalist>
                <p class="pmgr-hint">${t ? `${esc(t.name)} ${esc(t.version)} · ${esc(t.status)}` : p.target ? (state.targets ? "설치되어 있지 않습니다." : "설치 패키지 목록을 읽지 못했습니다.") : "지정하면 적용 여부와 업데이트 후 재실행 필요를 자동으로 확인합니다."}</p>
            </div>
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("circleCheck", 12)}적용 기록</span>
                <p class="pmgr-hint">${p.applied ? `${fmtTime(p.applied.at)} · 코드 ${esc(shortHash(p.applied.hash))}${p.applied.version ? ` · 대상 ${esc(p.applied.version)}` : ""}` : "기록 없음"}</p>
                <div class="pmgr-gh-actions">
                    <button type="button" class="pmgr-btn" data-act="mark-applied" data-id="${id}">${icon("check", 13)}적용됨으로 표시</button>
                    ${p.applied ? `<button type="button" class="pmgr-btn is-ghost" data-act="mark-off" data-id="${id}">기록 지우기</button>` : ""}
                </div>
            </div>
            ${sourceSectionHtml(p)}`;
}

/** What a runtime patch is: the file, where it loads, which versions it was made for, the settings it reads. */
function runtimeFieldsHtml(p) {
  const rt = p.rt || {};
  const targets = rt.targets || [];
  const configs = rt.configs || [];
  return `<div class="pmgr-field">
                <span class="pmgr-field-label">${icon("terminal", 12)}런타임 패치</span>
                <p class="pmgr-hint">마리나라가 켜질 때 .env의 NODE_OPTIONS(--require)로 불러와, 파일은 바꾸지 않고 불러오는 코드만 고칩니다. 켜기·끄기·순서는 마리나라를 다시 켤 때 반영됩니다.</p>
                <dl class="pmgr-info">
                    <dt>파일</dt><dd class="pmgr-mono">${esc(rt.path)}${rt.size ? ` · ${kb(rt.size)}` : ""}</dd>
                    <dt>불러오는 순서</dt><dd>${rt.actual ? `${rt.order + 1}번째` : "불러오지 않음"}</dd>
                    <dt>확인</dt><dd>${rt.seenAt ? fmtTime(rt.seenAt) : "-"}</dd>
                </dl>
            </div>
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("package", 12)}맞춘 버전</span>
                ${
                  targets.length
                    ? `<ul class="pmgr-plain-list">${targets
                        .map((t) => {
                          const now = installedVersion(t);
                          const ok = t.wants.includes(now);
                          return `<li><span class="pmgr-status is-${ok ? "on" : "pending"}">${icon(ok ? "circleCheck" : "shieldAlert", 11)}${ok ? "맞음" : "다름"}</span>${esc(t.name)} ${esc(t.wants.join("/"))}용 · 지금 ${esc(now)}</li>`;
                        })
                        .join("")}</ul>`
                    : `<p class="pmgr-hint">특정 패키지 버전 이름이 코드에 없습니다(엔진 전반에 걸리는 패치).</p>`
                }
            </div>
            ${
              configs.length
                ? `<div class="pmgr-field">
                <span class="pmgr-field-label">${icon("fileCode", 12)}설정 파일</span>
                <ul class="pmgr-plain-list">${configs.map((c) => `<li><span class="pmgr-mono">${esc(c.path)}</span> <span class="pmgr-hint">· ${esc(c.via === "같은 폴더" ? "패치 옆" : ".env " + c.via)}${c.exists ? "" : " · 파일 없음"}</span></li>`).join("")}</ul>
                <p class="pmgr-hint">패치가 읽는 설정·레시피(JSON)입니다. 바꾼 뒤에는 마리나라를 다시 켜야 반영됩니다.</p>
            </div>`
                : ""
            }`;
}

function renderDetail() {
  const p = patchOf(state.selectedId);
  refs.detail.classList.toggle("is-open", !!p);
  root.querySelector(".pmgr-body").classList.toggle("has-detail", !!p);
  if (!p) {
    setHtml(refs.detail, "");
    return;
  }
  const tint = groupOf(p.group)?.color;
  if (tint) refs.detail.style.setProperty("--pm-on", tint);
  else refs.detail.style.removeProperty("--pm-on");
  const { key, reason } = statusInfo(p);
  const t = targetOf(p);
  const id = esc(p.id);
  const keepScroll = refs.detail.dataset.id === p.id ? refs.detail.querySelector(".pmgr-detail-scroll")?.scrollTop || 0 : 0;
  refs.detail.dataset.id = p.id;
  const confirming = state.confirmDelete === p.id;
  const codeOpen = state.codeOpen === p.id;
  setHtml(
    refs.detail,
    `
        <div class="pmgr-detail-head">
            <div class="pmgr-detail-title">
                <strong>${esc(p.name)}</strong>
                <span class="pmgr-ver">${esc(isRuntime(p) ? p.rt.path : p.file)}</span>
            </div>
            <button type="button" class="pmgr-icon-btn" data-act="detail-close" aria-label="상세 닫기">${icon("x", 15)}</button>
        </div>
        <div class="pmgr-detail-scroll">
            <div class="pmgr-detail-status is-${STATUS[key].css}">${icon(STATUS[key].icon, 14)}<div><strong>${esc(labelOf(p))}</strong><span>${esc(reason)}</span>
                ${t?.error ? `<span class="pmgr-err">${esc(t.error)}</span>` : ""}</div></div>
            ${
              isRuntime(p)
                ? `<div class="pmgr-detail-actions">
                <button type="button" class="pmgr-btn${p.include ? "" : " is-primary"}" data-act="include" data-id="${id}">${icon(p.include ? "powerOff" : "power", 13)}${p.include ? "끄기" : "켜기"}</button>
                <button type="button" class="pmgr-btn is-danger" data-act="delete" data-id="${id}" title="관리자 목록에서만 지웁니다. 파일과 .env는 그대로입니다.">${icon("trash", 13)}${confirming ? "정말 목록에서 지우기" : "목록에서 지우기"}</button>
            </div>`
                : ""
            }
            ${
              isRuntime(p)
                ? ""
                : `<div class="pmgr-detail-actions">
                <button type="button" class="pmgr-btn ${key === "applied" ? "" : "is-primary"}" data-act="run-one" data-id="${id}">${icon("download", 13)}실행 파일</button>
                ${p.restore ? `<button type="button" class="pmgr-btn" data-act="restore-one" data-id="${id}">${icon("undo", 13)}되돌리기 파일</button>` : ""}
                <button type="button" class="pmgr-btn" data-act="include" data-id="${id}">${icon(p.include ? "powerOff" : "power", 13)}${p.include ? "목록에서 빼기" : "목록에 넣기"}</button>
                <button type="button" class="pmgr-btn is-danger" data-act="delete" data-id="${id}">${icon("trash", 13)}${confirming ? "정말 삭제" : "삭제"}</button>
            </div>`
            }
            <p class="pmgr-detail-desc">${esc(p.description || "설명 없음")}</p>
            ${isRuntime(p) ? runtimeFieldsHtml(p) : scriptFieldsHtml(p, id, t)}
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("folder", 12)}그룹</span>
                ${
                  state.editingGroup === `detail:${p.id}`
                    ? `<div class="pmgr-tag-edit"><input data-group-input="new" data-assign="${id}" placeholder="새 그룹 이름 입력 후 Enter" maxlength="40"></div>`
                    : `<label class="pmgr-select is-block"><select data-detail-group="${id}">
                    <option value="">미분류</option>
                    ${state.groups.map((g) => `<option value="${esc(g.id)}"${p.group === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}
                    <option value="__new">+ 새 그룹 만들기…</option>
                </select></label>`
                }
            </div>
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("tag", 12)}태그</span>
                <div class="pmgr-tag-edit">
                    ${p.tags.map((tg) => `<span class="pmgr-chip is-removable">#${esc(tg)}<button type="button" data-act="tag-remove" data-id="${id}" data-v="${esc(tg)}" aria-label="태그 ${esc(tg)} 제거">${icon("x", 10)}</button></span>`).join("")}
                    <input data-detail-tag="${id}" placeholder="태그 입력 (Enter, 쉼표, #)" enterkeyhint="done">
                </div>
                <div class="pmgr-tag-cloud pmgr-tag-suggest" data-tag-suggest></div>
            </div>
            <div class="pmgr-field">
                <span class="pmgr-field-label">${icon("note", 12)}메모</span>
                <textarea data-detail-note="${id}" rows="3" placeholder="이 패치에 대한 메모 (검색에 포함됩니다)">${esc(p.note)}</textarea>
            </div>
            <dl class="pmgr-info">
                <dt>순서</dt><dd>${state.patches.indexOf(p) + 1}번째 <button type="button" class="pmgr-act" data-act="move-up" data-id="${id}" aria-label="앞으로">${icon("chevronUp", 12)}</button><button type="button" class="pmgr-act" data-act="move-down" data-id="${id}" aria-label="뒤로">${icon("chevronDown", 12)}</button></dd>
                ${isRuntime(p) ? "" : `<dt>되돌리기</dt><dd>${p.restore ? "--restore 지원" : "지원 안 함"}</dd>`}
                <dt>크기</dt><dd>${kb(p.size)}</dd>
                <dt>추가일</dt><dd>${fmtDate(p.addedAt)}</dd>
                <dt>수정일</dt><dd>${fmtDate(p.updatedAt)}</dd>
                <dt>해시</dt><dd class="pmgr-mono" title="${esc(p.hash)}">${esc(shortHash(p.hash))}</dd>
            </dl>
            ${isRuntime(p) ? "" : `<details class="pmgr-code" data-code="${id}"${codeOpen ? " open" : ""}><summary>코드 보기</summary>${codeOpen ? `<pre>${esc(state.scripts[p.id])}</pre>` : ""}</details>`}
        </div>`,
  );
  if (keepScroll) refs.detail.querySelector(".pmgr-detail-scroll").scrollTop = keepScroll;
}

function renderHeader() {
  const applied = state.patches.filter((p) => statusOf(p) === "applied").length;
  const stale = state.patches.filter((p) => statusOf(p) === "stale").length;
  refs.sub.textContent = state.patches.length ? `패치 ${state.patches.length}개 · 적용 ${applied}개${stale ? ` · 다시 실행 필요 ${stale}개` : ""}` : "";
  root.querySelector(".pmgr-menu-btn").classList.toggle("has-filter", !!filterActive());
  const busy = state.loading || !!state.checkingAll;
  for (const button of root.querySelectorAll(".pmgr-refresh-btn")) {
    if (button.disabled === busy) continue;
    button.disabled = busy;
    button.innerHTML = icon(busy ? "loader" : "refresh", 15);
  }
}

function render() {
  if (!root || stopped) return;
  renderHeader();
  renderSide();
  renderMain();
  renderDetail();
}
let softFrame = 0;
function renderSoft() {
  if (softFrame || stopped) return;
  softFrame = requestAnimationFrame(() => {
    softFrame = 0;
    renderSoftNow();
  });
}
function renderSoftNow() {
  if (!root || !state.open) return;
  const typing = (box) => box.contains(document.activeElement) && document.activeElement.matches("input, textarea, select");
  renderHeader();
  if (!typing(refs.side)) renderSide();
  if (!typing(refs.main)) renderMain();
  if (!typing(refs.detail)) renderDetail();
}
function renderFlowArea() {
  if (state.flow?.target) renderDetail();
  else renderMain();
}

async function runFlow(busyText, task) {
  const flow = state.flow;
  if (!flow || flow.busy) return;
  flow.busy = busyText;
  flow.error = "";
  renderFlowArea();
  try {
    await task(flow);
  } catch (err) {
    flow.error = err instanceof Error ? err.message : String(err);
  } finally {
    flow.busy = "";
    if (state.flow === flow && state.open) renderFlowArea();
  }
}
function startFind() {
  const flow = state.flow;
  const input = root.querySelector("[data-flow-url]");
  if (!flow || !input) return;
  flow.url = input.value.trim();
  void runFlow("공개 저장소에서 패치를 찾는 중…", async () => {
    flow.snapshot = await discoverRepo(flow.url);
    flow.choiceIndex = 0;
    flow.step = "choose";
  });
}
function loadChoice() {
  const flow = state.flow;
  const select = root.querySelector("[data-flow-choice]");
  if (!flow || !select) return;
  flow.choiceIndex = Number(select.value) || 0;
  void runFlow("패치를 내려받는 중…", async () => {
    const snap = flow.snapshot;
    const choice = snap.choices[flow.choiceIndex];
    const text = await fetchRepoFile(snap.repo, choice.path, snap.sha);
    flow.pkg = await makePkg(text, `${snap.repo.split("/")[1]}/${choice.path}`, { kind: "github", repo: snap.repo, path: choice.path, branch: snap.branch, ref: snap.sha });
    flow.step = "preview";
  });
}
const readScript = async (file, path) => {
  if (file.size > SCRIPT_LIMIT) throw new Error("패치 스크립트가 2MB를 넘습니다.");
  return makePkg(decodeText(new Uint8Array(await file.arrayBuffer())), path, { kind: "local", fileName: path });
};

/** Patch scripts already on this computer: one file goes to the preview; several, or a whole folder, to a list. */
function importLocal(intoId = null, folder = false) {
  pickFiles(".mjs,.js,.cjs,text/javascript", { multiple: !intoId, folder }, async (files) => {
    if (intoId) {
      state.flow = { target: intoId, mode: "update", step: "preview", url: "" };
      state.selectedId = intoId;
    } else if (!state.flow) {
      openAdd();
    }
    const flow = state.flow;
    await runFlow(folder ? "폴더에서 패치를 찾는 중…" : "파일을 읽는 중…", async () => {
      const pathOf = (f) => f.webkitRelativePath || f.name;
      const picked = files.filter((f) => !/(^|\/)(node_modules|\.git)\//.test(pathOf(f)));
      const found = folder ? picked.filter((f) => PATCH_FILE.test(pathOf(f)) && f.size <= SCRIPT_LIMIT) : picked;
      if (!found.length) throw new Error("이 폴더에서 패치 스크립트를 찾지 못했습니다. patch/ 폴더의 .mjs·.js, 또는 이름에 patch가 들어간 .mjs·.cjs를 찾습니다.");
      if (found.length === 1 && !folder) {
        flow.pkg = await readScript(found[0], pathOf(found[0]));
        flow.step = "preview";
        return;
      }
      flow.items = [];
      for (const f of found.slice(0, 60)) {
        try {
          const pkg = await readScript(f, pathOf(f));
          const dupe = state.patches.find((x) => x.hash === pkg.hash) || flow.items.find((x) => x.pkg?.hash === pkg.hash);
          flow.items.push({ path: pathOf(f), pkg, dupe: dupe ? dupe.name || dupe.pkg.info.name : null, checked: !dupe });
        } catch (err) {
          flow.items.push({ path: pathOf(f), error: err instanceof Error ? err.message : String(err) });
        }
      }
      flow.step = "multi";
    });
    if (intoId) renderDetail();
  });
}

function addPicked(flow) {
  const picked = flow.items.filter((x) => x.pkg && x.checked && !x.dupe);
  if (!picked.length) return notice("추가할 패치를 골라 주십시오.");
  if (!fitsStorage(picked.map((x) => x.pkg.text).join(""))) return;
  flow.resultIds = picked.map((x) => createPatch(x.pkg, false).id);
  flow.step = "done";
  render();
}
function focusFlowInput() {
  root.querySelector("[data-flow-url]")?.focus();
}

function notice(message) {
  if (!refs.notice) return;
  refs.notice.textContent = message;
  refs.notice.classList.add("is-show");
  marinara.clearTimeout(noticeTimer);
  noticeTimer = marinara.setTimeout(() => refs.notice?.classList.remove("is-show"), 3200);
}
function setSideOpen(openSide) {
  root.classList.toggle("is-side-open", openSide);
}
function setFilter(key, value) {
  state.filter[key] = state.filter[key] === value ? (key === "status" ? "all" : null) : value;
  state.view = "list";
  setSideOpen(false);
  renderHeader();
  renderSide();
  renderMain();
}
function setView(view) {
  if (state.flow?.busy) return;
  state.view = view;
  if (view !== "add") state.flow = null;
  state.backupPreview = null;
  setSideOpen(false);
  renderMain();
  renderDetail();
}
function openAdd() {
  if (state.flow?.busy) return;
  state.flow = { target: null, mode: "add", step: "url", url: "" };
  state.view = "add";
  state.selectedId = null;
  setSideOpen(false);
  renderMain();
  renderDetail();
  focusFlowInput();
}

function movePatch(id, delta) {
  const list = state.patches;
  const from = list.findIndex((p) => p.id === id);
  if (from < 0) return;
  // Move past the neighbours that are in the same view (the run list skips excluded patches).
  const inRun = state.view === "run";
  let to = from + delta;
  while (to >= 0 && to < list.length && ((inRun && !list[to].include) || isRuntime(list[to]) !== isRuntime(list[from]))) to += delta;
  if (to < 0 || to >= list.length) return;
  list.splice(to, 0, ...list.splice(from, 1));
  scheduleSave();
  render();
}

function commitGroupInput(input) {
  const id = input.dataset.groupInput;
  const name = input.value.trim().slice(0, 40);
  state.editingGroup = null;
  if (name) {
    if (id === "new") {
      const group = { id: newId("g"), name, color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length] };
      state.groups.push(group);
      const assign = patchOf(input.dataset.assign);
      if (assign) assign.group = group.id;
    } else {
      const group = groupOf(id);
      if (group) group.name = name;
    }
    scheduleSave();
  }
  render();
}
function addTag(ids, raw) {
  const list = raw
    .split(/[,#]/)
    .map((t) => t.trim().replace(/\s+/g, " ").slice(0, 30))
    .filter(Boolean);
  if (!list.length) return false;
  for (const id of ids) {
    const p = patchOf(id);
    if (!p) continue;
    p.tags = [...p.tags, ...list.filter((t, i) => !p.tags.includes(t) && list.indexOf(t) === i)];
  }
  scheduleSave();
  return true;
}
function commitTagInput(el, raw, rest = "") {
  const bulk = el.matches("[data-bulk-tag]");
  if (!addTag(bulk ? [...state.checked] : [el.dataset.detailTag], raw)) return;
  render();
  const input = root.querySelector(bulk ? "[data-bulk-tag]" : "[data-detail-tag]");
  if (input) {
    input.value = rest;
    input.focus();
    renderTagSuggest(input);
  }
  if (bulk) notice("선택한 패치에 태그를 추가했습니다.");
}
function tagSuggestBox(input) {
  return input.parentElement.parentElement.querySelector("[data-tag-suggest]");
}
function renderTagSuggest(input) {
  const box = tagSuggestBox(input);
  if (!box) return;
  const bulk = input.matches("[data-bulk-tag]");
  const ids = bulk ? [...state.checked] : [input.dataset.detailTag];
  const q = input.value.replace(/^#/, "").trim().toLowerCase();
  const owned = (t) => ids.every((id) => patchOf(id)?.tags.includes(t));
  const hits = q ? allTags().filter(([t]) => !owned(t) && t.toLowerCase().includes(q)) : [];
  hits.sort((a, b) => b[0].toLowerCase().startsWith(q) - a[0].toLowerCase().startsWith(q));
  box.innerHTML = hits
    .slice(0, 8)
    .map(([t, n]) => `<button type="button" class="pmgr-tag" data-act="tag-suggest"${bulk ? ' data-bulk="1"' : ""} data-v="${esc(t)}">#${esc(t)}<span>${n}</span></button>`)
    .join("");
}

let confirmTimer = 0;
function onClick(event) {
  const target = event.target.closest("[data-act]");
  if (!target || !root.contains(target)) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  const p = id ? patchOf(id) : null;
  switch (act) {
    case "close":
      return close();
    case "side-toggle":
      return setSideOpen(!root.classList.contains("is-side-open"));
    case "side-close":
      return setSideOpen(false);
    case "refresh":
      return void reload().then(() => checkAll());
    case "f-status":
      return setFilter("status", target.dataset.v);
    case "f-group":
      return setFilter("group", target.dataset.v);
    case "f-tag":
      return setFilter("tag", target.dataset.v);
    case "f-target":
      return setFilter("target", target.dataset.v);
    case "f-gh":
      return setFilter("gh", target.dataset.v);
    case "f-group-all":
      return setFilter("group", null);
    case "f-pinned":
      state.filter.pinned = !state.filter.pinned;
      state.view = "list";
      setSideOpen(false);
      renderHeader();
      renderSide();
      return renderMain();
    case "f-reset":
      resetFilter();
      setSideOpen(false);
      renderHeader();
      renderSide();
      return renderMain();
    case "view":
      state.prefs.view = target.dataset.v;
      scheduleSave();
      return renderMain();
    case "grouped":
      state.prefs.grouped = !state.prefs.grouped;
      scheduleSave();
      return renderMain();
    case "select":
      if (event.ctrlKey || event.metaKey) {
        if (state.checked.has(id)) state.checked.delete(id);
        else state.checked.add(id);
        return renderMain();
      }
      state.selectedId = state.selectedId === id ? null : id;
      if (state.flow?.target && !state.flow.busy) state.flow = null;
      renderMain();
      return renderDetail();
    case "check":
      event.stopPropagation();
      if (state.checked.has(id)) state.checked.delete(id);
      else state.checked.add(id);
      return renderMain();
    case "pin":
      event.stopPropagation();
      if (!p) return;
      p.pinned = !p.pinned;
      scheduleSave();
      renderSide();
      return renderMain();
    case "include":
      event.stopPropagation();
      if (!p) return;
      p.include = !p.include;
      scheduleSave();
      return render();
    case "run-one":
      event.stopPropagation();
      return p && void downloadRunner([p], "apply", `marinara-patch-${p.file.replace(/\.(mjs|cjs|js)$/i, "")}.mjs`);
    case "restore-one":
      return p && void downloadRunner([p], "restore", `marinara-restore-${p.file.replace(/\.(mjs|cjs|js)$/i, "")}.mjs`);
    case "delete":
      event.stopPropagation();
      if (!p) return;
      if (state.confirmDelete !== id) {
        state.confirmDelete = id;
        state.selectedId = id;
        marinara.clearTimeout(confirmTimer);
        confirmTimer = marinara.setTimeout(() => {
          state.confirmDelete = null;
          renderSoft();
        }, 4000);
        renderMain();
        renderDetail();
        return notice("한 번 더 누르면 삭제합니다. 이미 적용한 패치는 먼저 되돌려 주십시오.");
      }
      state.confirmDelete = null;
      deletePatch(id);
      render();
      return notice(`"${p.name}"을(를) 삭제했습니다.`);
    case "detail-close":
      state.selectedId = null;
      if (state.flow?.target && !state.flow.busy) state.flow = null;
      renderMain();
      return renderDetail();
    case "move-up":
      return movePatch(id, -1);
    case "move-down":
      return movePatch(id, 1);
    case "mark-applied":
      markApplied([id], true);
      return notice("적용됨으로 기록했습니다.");
    case "mark-off":
      return markApplied([id], false);
    case "group-add":
      state.editingGroup = "new";
      return renderSide();
    case "group-rename":
      state.editingGroup = id;
      return renderSide();
    case "group-edit":
      state.groupEdit = !state.groupEdit;
      return renderSide();
    case "group-up": {
      const index = state.groups.findIndex((g) => g.id === id);
      return index > 0 && moveGroup(id, index - 1);
    }
    case "group-color": {
      const group = groupOf(id);
      if (!group) return;
      group.color = GROUP_COLORS[(GROUP_COLORS.indexOf(group.color) + 1) % GROUP_COLORS.length];
      scheduleSave();
      return render();
    }
    case "group-del":
      state.groups = state.groups.filter((g) => g.id !== id);
      for (const x of state.patches) if (x.group === id) x.group = null;
      if (state.filter.group === id) state.filter.group = null;
      scheduleSave();
      return render();
    case "tag-suggest": {
      const input = target.dataset.bulk ? root.querySelector("[data-bulk-tag]") : refs.detail.querySelector("[data-detail-tag]");
      if (input) commitTagInput(input, target.dataset.v);
      return;
    }
    case "tag-remove":
      if (!p) return;
      p.tags = p.tags.filter((t) => t !== target.dataset.v);
      if (state.filter.tag === target.dataset.v && !allTags().some(([t]) => t === target.dataset.v)) state.filter.tag = null;
      scheduleSave();
      return render();
    case "bulk-pin": {
      const ids = [...state.checked];
      const pinned = ids.every((x) => patchOf(x)?.pinned);
      for (const x of ids) if (patchOf(x)) patchOf(x).pinned = !pinned;
      scheduleSave();
      renderSide();
      return renderMain();
    }
    case "bulk-panel":
      state.bulkPanel = state.bulkPanel === target.dataset.v ? null : target.dataset.v;
      renderMain();
      return root.querySelector("[data-bulk-tag]")?.focus();
    case "bulk-group":
      for (const x of state.checked) if (patchOf(x)) patchOf(x).group = target.dataset.v || null;
      state.bulkPanel = null;
      scheduleSave();
      return render();
    case "bulk-run":
      return void downloadRunner(state.patches.filter((x) => state.checked.has(x.id) && !isRuntime(x)), "apply");
    case "bulk-clear":
      state.checked.clear();
      return renderMain();
    case "add-open":
      return openAdd();
    case "run-open":
      return setView("run");
    case "settings-open":
      state.selectedId = null;
      return setView("settings");
    case "view-close":
      return setView("list");
    case "run-mode":
      state.runMode = target.dataset.v;
      return renderMain();
    case "run-download":
      return void downloadRunner(runList(), state.runMode, state.runMode === "restore" ? "marinara-patches-restore.mjs" : BUNDLE_NAME);
    case "run-confirm": {
      const run = state.lastRun;
      if (!run) return;
      const ids = run.items.filter((x) => !x.done).map((x) => x.id);
      markApplied(ids, run.mode !== "restore");
      return notice(run.mode === "restore" ? "되돌린 것으로 기록했습니다." : "적용됨으로 기록했습니다.");
    }
    case "run-dismiss":
      state.lastRun = null;
      scheduleSave();
      return render();
    case "copy":
      return void copyText(target.dataset.v);
    case "import-file":
      return importLocal();
    case "import-folder":
      return importLocal(null, true);
    case "runtime-apply":
      return void applyRuntime();
    case "runtime-revert":
      for (const x of runtimeItems()) x.include = !!x.rt?.actual && x.rt.exists !== false;
      orderRuntimeByActual();
      state.auto = { ...(state.auto || {}), error: "" };
      scheduleSave();
      return render();
    case "auto-run":
      return void startAuto(runList(), state.runMode);
    case "helper-download":
      saveFile(HELPER_NAME, buildHelper(), "text/javascript");
      return notice(`${HELPER_NAME}을(를) 내려받습니다. 마리나라 엔진 폴더에 넣어 주십시오.`);
    case "helper-code-save": {
      const raw = root.querySelector("[data-helper-code]")?.value || "";
      const code = raw.replace(/[^0-9a-f]/gi, "").toLowerCase();
      if (code.length !== 32) return notice("연결 코드는 16진수 32자리입니다(하이픈은 빼도 됩니다). 도우미 터미널에 나온 그대로 넣어 주십시오.");
      try {
        localStorage.setItem(HELPER_KEY, code);
      } catch {
        return notice("이 브라우저에 저장하지 못했습니다(사생활 보호 모드 등).");
      }
      renderMain();
      return notice("연결 코드를 저장했습니다.");
    }
    case "helper-code-clear":
      try {
        localStorage.removeItem(HELPER_KEY);
      } catch {}
      return renderMain();
    case "flow-add-picked":
      return state.flow?.items && !state.flow.busy && addPicked(state.flow);
    case "scan-open":
      state.selectedId = null;
      return setView("scan");
    case "scan-pick":
      return void runScan();
    case "scan-pick-plain":
      return void runScan(true);
    case "scan-helper":
      return void runHelperScan();
    case "backup-del":
      return void deleteBackups([target.dataset.v], target.dataset.v);
    case "backup-del-all":
      return void deleteBackups(state.scan?.backups.map((b) => b.path) || [], "__all");
    case "backup-clean-file": {
      const paths = state.scan?.backups.map((b) => b.path) || [];
      if (!paths.length) return;
      saveFile("marinara-clean-backups.mjs", buildCleaner(paths), "text/javascript");
      return notice("정리 파일을 내려받습니다. 마리나라 엔진 폴더에서 실행해 주십시오.");
    }
    case "replace-file":
      return p && importLocal(p.id);
    case "gh-connect": {
      if (state.flow?.busy || !p) return;
      const src = p.source;
      state.flow = { target: id, mode: "link", step: "url", url: src.kind === "github" ? `https://github.com/${src.repo}/blob/${src.branch || src.ref}/${src.path}` : "" };
      renderMain();
      renderDetail();
      return focusFlowInput();
    }
    case "gh-view-update":
      if (state.flow?.busy || !state.updates.has(id)) return;
      state.flow = { target: id, mode: "update", step: "preview", pkg: state.updates.get(id) };
      return renderDetail();
    case "gh-unlink":
      if (!p) return;
      p.source = { kind: "local", fileName: p.file };
      state.updates.delete(id);
      scheduleSave();
      return render();
    case "gh-check":
      if (p) checkUpdate(p).catch((err) => notice(err.message));
      return;
    case "gh-check-all":
      return void checkAll();
    case "flow-find":
      return startFind();
    case "flow-back":
      if (state.flow && !state.flow.busy) {
        state.flow.step = "url";
        state.flow.error = "";
        renderFlowArea();
        focusFlowInput();
      }
      return;
    case "flow-load":
      return loadChoice();
    case "flow-link": {
      const flow = state.flow;
      const x = flow && patchOf(flow.target);
      if (!x || flow.busy) return;
      x.source = sourceFrom(flow.pkg);
      if (flow.pkg.hash !== x.hash) {
        state.updates.set(x.id, flow.pkg);
        x.source.message = "새 코드 있음 · 연결됨";
      } else {
        state.updates.delete(x.id);
        x.source.message = "최신 상태 · 연결됨";
      }
      scheduleSave();
      state.flow = null;
      render();
      return notice("GitHub 파일을 연결했습니다. 코드는 바꾸지 않았습니다.");
    }
    case "flow-apply": {
      const flow = state.flow;
      if (!flow?.pkg || flow.busy) return;
      if (flow.target) {
        const x = patchOf(flow.target);
        if (!x || !fitsStorage(flow.pkg.text, x.id)) return;
        replaceCode(x, flow.pkg);
        state.flow = null;
        render();
        return notice(x.applied ? "업데이트를 받았습니다. 실행 파일을 다시 돌려 주십시오." : "업데이트를 받았습니다.");
      }
      const input = root.querySelector("[data-flow-target]");
      flow.pkg.target = input ? input.value.trim() : flow.pkg.info.target;
      if (!fitsStorage(flow.pkg.text)) return;
      const created = createPatch(flow.pkg, !!root.querySelector("[data-flow-applied]")?.checked);
      flow.resultId = created.id;
      flow.step = "done";
      return render();
    }
    case "flow-show":
      state.flow = null;
      state.view = "list";
      state.selectedId = id;
      return render();
    case "flow-again":
      return openAdd();
    case "flow-cancel":
      if (state.flow?.busy) return;
      if (!state.flow?.target) state.view = "list";
      state.flow = null;
      renderMain();
      return renderDetail();
    case "backup-export":
      return exportBackup();
    case "backup-import":
      return pickFile(".json,application/json", (file) => void readBackup(file));
    case "backup-apply":
      return applyBackup();
    case "backup-cancel":
      state.backupPreview = null;
      return renderMain();
    default:
  }
}

function onChange(event) {
  const el = event.target;
  if (el.matches("[data-pref]")) {
    state.prefs[el.dataset.pref] = el.checked;
    scheduleSave();
  } else if (el.matches("[data-pref-text]")) {
    state.prefs[el.dataset.prefText] = el.value.trim().slice(0, 500);
    scheduleSave();
    renderMain();
  } else if (el.matches("[data-ref-sort]")) {
    state.prefs.sort = el.value;
    scheduleSave();
    renderMain();
  } else if (el.matches("[data-flow-applied]") && state.flow) {
    state.flow.alreadyApplied = el.checked;
  } else if (el.matches("[data-pick]") && state.flow?.items) {
    const item = state.flow.items[Number(el.dataset.pick)];
    if (item) item.checked = el.checked;
    renderMain();
  } else if (el.matches("[data-detail-target]")) {
    const p = patchOf(el.dataset.detailTarget);
    if (!p) return;
    const next = el.value.trim().slice(0, 120);
    if (next === p.target) return;
    p.target = next;
    // A record taken against another package says nothing about this one.
    if (p.applied) p.applied = { ...p.applied, version: targetOf(p)?.version || null, fingerprint: targetOf(p)?.fingerprint || null };
    scheduleSave();
    render();
  } else if (el.matches("[data-detail-group]")) {
    const p = patchOf(el.dataset.detailGroup);
    if (!p) return;
    if (el.value === "__new") {
      state.editingGroup = `detail:${p.id}`;
      renderDetail();
      refs.detail.querySelector("[data-group-input]")?.focus();
      return;
    }
    p.group = el.value || null;
    scheduleSave();
    renderSide();
    renderMain();
  } else if (el.matches("[data-detail-note]")) {
    renderMain();
  }
}

function onInput(event) {
  const el = event.target;
  if (el === refs.search) {
    if (!el.value && state.filter.q) applySearch();
  } else if (el.matches("[data-detail-note]")) {
    const p = patchOf(el.dataset.detailNote);
    if (p) {
      p.note = el.value.slice(0, 2000);
      scheduleSave();
    }
  } else if (el.matches("[data-flow-url]") && state.flow) {
    state.flow.url = el.value;
  } else if (el.matches("[data-detail-tag], [data-bulk-tag]") && !event.isComposing) {
    const m = el.value.match(/^([\s\S]*)([,#])([^,#]*)$/);
    if (m && m[1].replace(/[\s,#]/g, "")) commitTagInput(el, m[1], m[2] === "#" ? `#${m[3]}` : m[3].trimStart());
    else renderTagSuggest(el);
  } else if (el.matches("[data-detail-tag], [data-bulk-tag]")) {
    renderTagSuggest(el);
  }
}
function applySearch() {
  state.filter.q = refs.search.value.trim();
  state.view = "list";
  renderHeader();
  renderMain();
}
function onKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  const el = event.target;
  if (el.matches("[data-group-input]")) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitGroupInput(el);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      state.editingGroup = null;
      renderSide();
      renderDetail();
    }
  } else if (event.key === "Enter" && el.matches("[data-detail-tag], [data-bulk-tag]")) {
    event.preventDefault();
    commitTagInput(el, el.value);
  } else if (event.key === "Enter" && el === refs.search) {
    event.preventDefault();
    applySearch();
  } else if (event.key === "Enter" && el.matches("[data-flow-url]")) {
    event.preventDefault();
    startFind();
  } else if (event.key === "Enter" && el.matches("[data-detail-target], [data-pref-text]")) {
    event.preventDefault();
    el.blur();
  }
}

function moveGroup(id, toIndex) {
  const groups = state.groups;
  const from = groups.findIndex((g) => g.id === id);
  if (from < 0 || from === toIndex) return;
  groups.splice(toIndex, 0, ...groups.splice(from, 1));
  scheduleSave();
  render();
}
let dragGroupId = null;
function dropTarget(event) {
  const wrap = event.target.closest?.("[data-group-drag]");
  if (!wrap || !dragGroupId) return null;
  const rect = wrap.getBoundingClientRect();
  return { wrap, after: event.clientY > rect.top + rect.height / 2 };
}
function onDragStart(event) {
  const wrap = event.target.closest?.("[data-group-drag]");
  if (!wrap) return;
  dragGroupId = wrap.dataset.groupDrag;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragGroupId);
  wrap.classList.add("is-dragging");
}
function onDragOver(event) {
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  for (const el of refs.side.querySelectorAll(".is-drop-before, .is-drop-after")) el.classList.remove("is-drop-before", "is-drop-after");
  target.wrap.classList.add(target.after ? "is-drop-after" : "is-drop-before");
}
function onDrop(event) {
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  const groups = state.groups;
  const from = groups.findIndex((g) => g.id === dragGroupId);
  let to = groups.findIndex((g) => g.id === target.wrap.dataset.groupDrag) + (target.after ? 1 : 0);
  if (from < to) to -= 1;
  const id = dragGroupId;
  dragGroupId = null;
  moveGroup(id, to);
}
function onDragEnd() {
  dragGroupId = null;
  renderSide();
}

function onFocusOut(event) {
  const el = event.target;
  if (!document.hasFocus()) return;
  if (el.matches?.("[data-group-input]") && state.editingGroup) commitGroupInput(el);
  else if (el.matches?.("[data-detail-tag], [data-bulk-tag]")) tagSuggestBox(el)?.replaceChildren();
  renderSoft();
}

// The detail's code view is filled only when opened: some patches are long.
function onToggle(event) {
  const el = event.target;
  if (!el.matches?.("details[data-code]") || el.dataset.code === "flow") return;
  state.codeOpen = el.open ? el.dataset.code : null;
  if (el.open && !el.querySelector("pre")) el.insertAdjacentHTML("beforeend", `<pre>${esc(state.scripts[el.dataset.code] || "")}</pre>`);
}

function onDocKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || !state.open || document.querySelector(".mari-modal")) return;
  if (event.key === "Tab") {
    const nodes = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter(
      (el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden",
    );
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first) {
      event.preventDefault();
      root.focus();
      return;
    }
    if (!root.contains(document.activeElement) || document.activeElement === root || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
    return;
  }
  const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]');
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === refs.search && refs.search.value) {
      refs.search.value = "";
      state.filter.q = "";
      return renderMain();
    }
    if (event.target.matches?.("[data-group-input]")) {
      state.editingGroup = null;
      renderSide();
      return renderDetail();
    }
    if (root.classList.contains("is-side-open")) return setSideOpen(false);
    if (state.flow?.target && !state.flow.busy) {
      state.flow = null;
      return renderDetail();
    }
    if (state.view !== "list") return setView("list");
    if (state.bulkPanel) {
      state.bulkPanel = null;
      return renderMain();
    }
    if (state.selectedId) {
      state.selectedId = null;
      renderMain();
      return renderDetail();
    }
    return close();
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    refs.search.focus();
  }
}

let returnFocus = null;
let openFrame = 0;
let bodyOverflow = null;
function restoreBodyScroll() {
  if (bodyOverflow !== null && document.body.style.overflow === "hidden") document.body.style.overflow = bodyOverflow;
  bodyOverflow = null;
}
function open(view = "list") {
  if (state.open) return;
  if (!root) {
    buildShell();
    root.addEventListener("toggle", onToggle, true);
  }
  returnFocus = document.activeElement;
  document.body.appendChild(root);
  bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  state.open = true;
  state.view = view;
  render();
  root.tabIndex = -1;
  openFrame = requestAnimationFrame(() => {
    openFrame = 0;
    if (!stopped && state.open) root.classList.add("is-in");
  });
  root.focus({ preventScroll: true });
  void flushSave();
  void reload();
}
function close() {
  if (!state.open) return;
  state.open = false;
  cancelAnimationFrame(openFrame);
  void flushSave();
  state.editingGroup = null;
  state.confirmDelete = null;
  if (!state.flow?.busy) state.flow = null;
  state.view = "list";
  root.classList.remove("is-in", "is-side-open");
  root.remove();
  restoreBodyScroll();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

// ---------- 진입 버튼 ----------

// The button sits in the external extensions settings section. When the GitHub extension manager is
// installed too, it joins that manager's button row instead of starting a second one.
function ensureEntry() {
  const section = document.getElementById(SECTION_ID);
  if (!section || section.querySelector(".pmgr-entry")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pmgr-entry";
  button.title = "서버 패치 관리자 열기";
  button.innerHTML = `${icon("wrench", 13)}<span>패치</span>`;
  button.addEventListener("click", () => open());
  const shared = section.querySelector(":scope > .xm-entry-row");
  if (shared) {
    shared.append(button);
    return;
  }
  let row = section.querySelector(":scope > .pmgr-entry-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "pmgr-entry-row";
    section.prepend(row);
  }
  row.append(button);
}

const entryWatch = { observer: null, frame: 0 };
function queueEntry() {
  if (stopped || entryWatch.frame) return;
  entryWatch.frame = requestAnimationFrame(() => {
    entryWatch.frame = 0;
    if (stopped) return;
    const section = document.getElementById(SECTION_ID);
    // Move from our own row into the GitHub manager's row once that appears.
    const own = section?.querySelector(":scope > .pmgr-entry-row");
    if (own && section.querySelector(":scope > .xm-entry-row")) own.remove();
    ensureEntry();
  });
}
function watchEntry() {
  entryWatch.observer = new MutationObserver((records) => {
    if (records.some((r) => !r.target.closest?.(".pmgr-overlay") && [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1))) queueEntry();
  });
  entryWatch.observer.observe(document.body, { childList: true, subtree: true });
  queueEntry();
}

document.addEventListener("keydown", onDocKeydown, true);
document.addEventListener("visibilitychange", onVisibilityChange);
watchEntry();
// Check the last run as soon as the page loads: Marinara has just restarted after a patch run.
void loadStorage()
  .then(() => (state.lastRun ? reload() : null))
  .catch(() => {});

marinara.onCleanup(() => {
  stopped = true;
  state.open = false;
  restoreBodyScroll();
  for (const controller of requests) controller.abort();
  requests.clear();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("keydown", onDocKeydown, true);
  entryWatch.observer?.disconnect();
  cancelAnimationFrame(entryWatch.frame);
  cancelAnimationFrame(softFrame);
  cancelAnimationFrame(openFrame);
  marinara.clearTimeout(confirmTimer);
  root?.remove();
  for (const el of document.querySelectorAll(".pmgr-entry, .pmgr-entry-row")) el.remove();
  return flushSave();
});
