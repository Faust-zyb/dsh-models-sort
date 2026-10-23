import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

const name = "dsh-models-sort";
const inject = ["webServer"];
const ROUTE_PREFIX = "/dsh-models-sort";
const TAG = "[models-sort]";

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function patchPath() {
  return join(dshHome(), "profiles", "desktop", "cordis.patch.yml");
}

const LOG_FILE = join(tmpdir(), "dsh-models-sort.log");

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

/** 归一化名字：忽略大小写、空白、引号，方便 "蜂巢 claude" 与 "蜂巢claude" 都能对上 */
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[⠿\s]+/g, "")
    .replace(/[「」『』"'`]/g, "");
}

/**
 * 把 providers: 段切成一块块的供应商定义。
 * 依赖文件里固定的缩进（providers 下面一层是 6 空格），不引入 yaml 依赖。
 */
function parseProviders(text) {
  const lines = text.split(/\r?\n/);
  let providersIdx = -1;
  let indent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)providers:\s*$/.exec(lines[i]);
    if (m) {
      providersIdx = i;
      indent = m[1].length;
      break;
    }
  }
  if (providersIdx < 0) return null;

  const childIndent = indent + 2;
  const start = providersIdx + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (/^\s*/.exec(line)[0].length <= indent) {
      end = i;
      break;
    }
  }

  const keyRe = new RegExp(`^\\s{${childIndent}}([^\\s#][^:]*):\\s*$`);
  const blocks = [];
  let cur = null;
  for (let i = start; i < end; i += 1) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    if (cur) blocks.push(cur);
    cur = { key: m[1].trim(), start: i };
  }
  if (cur) blocks.push(cur);
  for (let i = 0; i < blocks.length; i += 1) {
    blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : end;
    blocks[i].text = lines.slice(blocks[i].start, blocks[i].end).join("\n").replace(/\s+$/, "");
    let display = "";
    for (let j = blocks[i].start + 1; j < blocks[i].end; j += 1) {
      const m = /^\s*displayName:\s*(.+?)\s*$/.exec(lines[j]);
      if (m) {
        display = m[1].replace(/^["']|["']$/g, "");
        break;
      }
    }
    blocks[i].display = display;
  }

  return { head: lines.slice(0, start), tail: lines.slice(end), blocks };
}

/** 给一个块和前端名字打分：越像分越高，取最高分的块，避免 right-code 抢走 right-code-cloud */
function scoreBlock(block, n) {
  const k = norm(block.key);
  const d = norm(block.display || "");
  let best = 0;
  if (k === n) best = Math.max(best, 1000 + k.length);
  if (d && d === n) best = Math.max(best, 1000 + d.length);
  if (d.length > 1 && n.includes(d)) best = Math.max(best, 500 + d.length);
  if (k.length > 1 && n.includes(k)) best = Math.max(best, 300 + k.length);
  return best;
}

/** 把前端给的名字解析成 providers 的键；顺序即入参顺序，匹配不到的记进 unmatched */
function matchKeys(text, names) {
  const parsed = parseProviders(text);
  if (!parsed) return { ok: false, error: "没在 cordis.patch.yml 里找到 providers: 段" };
  const keys = [];
  const unmatched = [];
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    let best = null;
    let bestScore = 0;
    for (const block of parsed.blocks) {
      const s = scoreBlock(block, n);
      if (s > bestScore) {
        bestScore = s;
        best = block;
      }
    }
    if (best) keys.push(best.key);
    else unmatched.push(String(raw));
  }
  return { ok: keys.length > 0, keys, unmatched, blocks: parsed.blocks };
}

/** 按前端给的名字顺序重排 providers 段；匹配不到的保持原相对次序排在后面 */
function reorder(text, names) {
  const parsed = parseProviders(text);
  if (!parsed) return { ok: false, error: "没在 cordis.patch.yml 里找到 providers: 段" };
  if (parsed.blocks.length === 0) return { ok: false, error: "providers: 段里没有可排序的条目" };

  const remaining = [...parsed.blocks];
  const picked = [];
  const unmatched = [];

  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      const s = scoreBlock(remaining[i], n);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) picked.push(remaining.splice(bestIdx, 1)[0]);
    else unmatched.push(String(raw));
  }

  if (picked.length === 0) {
    return { ok: false, error: "一个供应商都没匹配上", received: names, known: parsed.blocks.map((b) => b.key) };
  }

  const ordered = [...picked, ...remaining];
  const body = ordered.map((b) => b.text).join("\n");
  const out = [...parsed.head, body, "", ...parsed.tail].join("\n");
  return {
    ok: true,
    text: out,
    matched: picked.length,
    total: parsed.blocks.length,
    unmatched,
    order: ordered.map((b) => b.key)
  };
}

/**
 * 按给定顺序重排一个 Map 的迭代顺序。
 * 只动 order 里出现的 key，其余条目保持原来的相对位置 ——
 * 这样 deepseek-account / deepseek-official 这些内置路由不会被挤到后面去。
 */
function reorderMap(map, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const entries = [...map.entries()];
  const moving = entries.filter(([key]) => rank.has(key)).sort((a, b) => rank.get(a[0]) - rank.get(b[0]));
  let cursor = 0;
  const rebuilt = entries.map(([key, value]) => (rank.has(key) ? moving[cursor++] : [key, value]));
  map.clear();
  for (const [key, value] of rebuilt) map.set(key, value);
}

/**
 * 让新顺序立刻在运行中的实例上生效。
 * llm 服务用 Map 的插入顺序回答 listProviders / listConfigurableProviders，
 * 而 llm-pi-ai 只在注册事实变化时才重新注册（键顺序变化不算），
 * 所以这里直接改这两个 Map 的迭代顺序，再广播一次 adapters-updated。
 */
function applyRuntimeOrder(ctx, order) {
  const llm = ctx.get?.("llm");
  if (!llm) return false;
  try {
    if (llm.adapters instanceof Map) reorderMap(llm.adapters, order);
    if (llm.directory instanceof Map) reorderMap(llm.directory, order);
    llm.emitAdaptersUpdated?.();
    return true;
  } catch (e) {
    log(`runtime reorder failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- 隐藏 ----------
// 隐藏的是"整行供应商"：聊天框模型选择器不再显示它，设置页仍保留行，随时可恢复。
const hiddenState = { keys: new Set() };

function hiddenFile() {
  return join(dirname(patchPath()), "dsh-models-sort.hidden.json");
}

function loadHidden() {
  try {
    const parsed = JSON.parse(readFileSync(hiddenFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function saveHidden() {
  try {
    writeFileSync(hiddenFile(), JSON.stringify([...hiddenState.keys], null, 2), "utf8");
  } catch (e) {
    log(`hidden 保存失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 隐藏项的展示名（给前端匹配卡片用），退回键名 */
function hiddenEntries(text) {
  const parsed = parseProviders(text || "");
  return [...hiddenState.keys].map((key) => {
    const block = parsed?.blocks.find((b) => b.key === key);
    return { key, display: block?.display || key };
  });
}

/**
 * 不删注册表条目（删了适配器实例就丢了，没法恢复），改成过滤 listProviders()。
 * 设置页用的 listConfigurableProviders() 不过滤，所以隐藏的行还在设置页里。
 */
function patchProviderFilter(ctx) {
  const llm = ctx.get?.("llm");
  if (!llm || typeof llm.listProviders !== "function") return false;
  if (llm.__dshMsFiltered) return true;
  const original = llm.listProviders.bind(llm);
  llm.listProviders = () => original().filter((p) => !hiddenState.keys.has(p?.id));
  llm.__dshMsFiltered = true;
  log("listProviders 过滤已安装");
  return true;
}

/** 从 query 里取名字：支持 names=a&names=b，也支持 names=["a","b"] 这种 JSON */
function namesFromQuery(url) {
  const out = [];
  for (const [k, v] of url.searchParams) {
    if (k !== "names" && k !== "name") continue;
    const raw = String(v).trim();
    if (raw.startsWith("[")) {
      try {
        for (const item of JSON.parse(raw)) out.push(String(item));
        continue;
      } catch {}
    }
    out.push(raw);
  }
  return out;
}

async function handle(req, res, ctx) {
  const url = new URL(req.url || "/", "http://localhost");
  if (!url.pathname.startsWith(ROUTE_PREFIX)) {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");
  log(`${req.method} ${url.pathname}${url.search ? "?" + url.search.slice(0, 300) : ""}`);

  if (sub === "" && (req.method === "GET" || req.method === "HEAD")) {
    const file = patchPath();
    let providers = [];
    try {
      const parsed = parseProviders(readFileSync(file, "utf8"));
      providers = parsed ? parsed.blocks.map((b) => ({ key: b.key, display: b.display })) : [];
    } catch {}
    const llm = ctx.get?.("llm");
    const runtime = llm && llm.adapters instanceof Map ? [...llm.adapters.keys()] : [];
    sendJson(res, 200, { ok: true, patch: file, exists: existsSync(file), providers, runtime });
    return;
  }

  if (sub === "hidden") {
    const file = patchPath();
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (req.method === "GET" || req.method === "HEAD") {
      sendJson(res, 200, { ok: true, hidden: [...hiddenState.keys], entries: hiddenEntries(text) });
      return;
    }
    if (req.method === "POST" || req.method === "PUT") {
      let names = namesFromQuery(url);
      let hide = true;
      try {
        const parsed = JSON.parse((await readBody(req)) || "{}");
        if (Array.isArray(parsed.names)) names = parsed.names.map(String);
        if (typeof parsed.hide === "boolean") hide = parsed.hide;
      } catch {}
      if (names.length === 0) {
        sendJson(res, 400, { ok: false, error: "没有收到名字列表" });
        return;
      }
      const matched = matchKeys(text, names);
      if (!matched.ok) {
        sendJson(res, 400, matched);
        return;
      }
      for (const key of matched.keys) {
        if (hide) hiddenState.keys.add(key);
        else hiddenState.keys.delete(key);
      }
      saveHidden();
      patchProviderFilter(ctx);
      ctx.get?.("llm")?.emitAdaptersUpdated?.();
      log(`hidden=${hide} -> ${matched.keys.join(",")} | 现在: ${[...hiddenState.keys].join(",")}`);
      sendJson(res, 200, { ok: true, hide, keys: matched.keys, hidden: [...hiddenState.keys], entries: hiddenEntries(text) });
      return;
    }
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  if (sub !== "order") {
    sendJson(res, 404, { ok: false, error: "unknown route" });
    return;
  }

  let names = namesFromQuery(url);
  if (req.method === "POST" || req.method === "PUT") {
    try {
      const parsed = JSON.parse((await readBody(req)) || "{}");
      if (Array.isArray(parsed.names)) names = parsed.names.map(String);
    } catch {}
  }
  if (names.length === 0) {
    sendJson(res, 400, { ok: false, error: "没有收到名字列表" });
    return;
  }

  const file = patchPath();
  if (!existsSync(file)) {
    sendJson(res, 500, { ok: false, error: `配置不存在：${file}` });
    return;
  }

  const before = readFileSync(file, "utf8");
  const result = reorder(before, names);
  log(`  names=${JSON.stringify(names)} -> ${result.ok ? "ok " + (result.order || []).join(",") : "FAIL " + result.error}`);
  if (!result.ok) {
    sendJson(res, 400, result);
    return;
  }

  if (result.text === before) {
    const runtime = applyRuntimeOrder(ctx, result.order);
    sendJson(res, 200, { ok: true, changed: false, runtime, matched: result.matched, total: result.total, order: result.order });
    return;
  }

  copyFileSync(file, `${file}.bak-${Date.now()}`);
  writeFileSync(file, result.text, "utf8");
  const runtime = applyRuntimeOrder(ctx, result.order);
  console.log(`${TAG} 顺序已写回：${result.order.join(" -> ")}（运行时重排${runtime ? "成功" : "失败"}）`);
  sendJson(res, 200, {
    ok: true,
    changed: true,
    runtime,
    matched: result.matched,
    total: result.total,
    unmatched: result.unmatched,
    order: result.order
  });
}

function apply(ctx) {
  // 隐藏列表先落地，再等 llm 服务就绪装过滤器
  hiddenState.keys = new Set(loadHidden());
  log(`启动，hidden=${[...hiddenState.keys].join(",") || "(无)"}`);
  if (!patchProviderFilter(ctx)) {
    let tries = 0;
    const timer = setInterval(() => {
      if (patchProviderFilter(ctx) || ++tries > 40) clearInterval(timer);
    }, 500);
    if (typeof timer.unref === "function") timer.unref();
  }

  const webServer = ctx.get?.("webServer") ?? ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    console.warn(`${TAG} webServer 不可用，拖拽结果将无法写回配置`);
    log("FAILED: webServer unavailable");
    return;
  }
  ctx.effect(
    () =>
      webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            await handle(req, res, ctx);
          } catch (e) {
            log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }),
    "dsh-models-sort: reorder route"
  );
}

export { apply, inject, name, reorder, parseProviders, reorderMap, matchKeys };
