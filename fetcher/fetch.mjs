#!/usr/bin/env node
/**
 * 羊毛雷达·抓取脚本（零依赖，Node >= 18，使用内置 fetch）
 *
 * 职责：
 *   1. 读取 fetcher/sources.json 中的渠道源配置（支持 RSS / JSON API 两种类型）
 *   2. 逐个请求并解析出羊毛条目（单个源失败自动跳过，不影响整体）
 *   3. 与 data/deals.json 中未过期的旧数据合并、去重、截断
 *   4. 写回 data/deals.json，供主页展示
 *
 * 用法：
 *   node fetcher/fetch.mjs
 *
 * 扩展新渠道：
 *   在 sources.json 里加一项即可，无需改代码。
 *   - type=rss    ：解析 <item><title><link><description><pubDate>
 *   - type=jsonapi ：按 mapping 把接口字段映射为标准条目
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_PATH = join(ROOT, "fetcher", "sources.json");
const DATA_PATH = join(ROOT, "data", "deals.json");

const MAX_ITEMS = 500;          // 数据总量上限，防止无限膨胀
const FETCH_TIMEOUT = 12_000;   // 单源超时（毫秒）
const KEEP_DAYS = 14;           // 已发布数据保留天数

const UA = "Mozilla/5.0 (compatible; WoolRadarBot/1.0; +https://github.com/yourname/wool-radar)";

/* ---------- 基础工具 ---------- */

function nowIso() {
  return new Date().toISOString();
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** 从标题/描述里尽力推断优惠力度，用于页面高亮展示 */
function guessValue(title, desc) {
  const text = `${title} ${desc}`;
  const patterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*元无门槛/, /(半价|5\s*折)/, /([0-9]+(?:\.[0-9]+)?)\s*折/,
    /(免单|免费领|白嫖|0\s*元)/, /([0-9]+(?:\.[0-9]+)?)\s*元红包/, /(立减|减|送)\s*([0-9]+(?:\.[0-9]+)?)\s*元/,
    /首月\s*([0-9]+)\s*元/, /([0-9]+)\s*GB\s*流量/
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return "";
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ctrl.signal,
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- RSS 解析（轻量手写，零依赖） ---------- */

function parseRss(xml, source) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) || [];
  for (const block of itemBlocks.slice(0, 60)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? stripHtml(m[1]) : "";
    };
    let title = pick("title");
    let link = pick("link");
    if (!link) {
      // Atom feed 的 link 常写作属性形式
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : "";
    }
    const desc = pick("description") || pick("summary") || pick("content");
    const pubDate = pick("pubDate") || pick("published") || pick("updated");

    if (!title || !link) continue;
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : nowIso();
    if (Number.isNaN(new Date(publishedAt).getTime())) continue;

    items.push({
      id: "rss-" + hashCode(link),
      title: title.slice(0, 120),
      desc: desc.slice(0, 300),
      channel: source.channel || source.name,
      category: source.category || "其他",
      value: guessValue(title, desc),
      url: link,
      expiresAt: null,
      publishedAt,
      hot: 100 + (hashCode(link).charCodeAt(0) % 900),
      tags: ["RSS", source.name]
    });
  }
  return items;
}

/* ---------- JSON API 解析（按 mapping 映射） ---------- */

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function parseJsonApi(json, source) {
  const mapping = source.mapping || {};
  const list = getByPath(json, mapping.listPath) || (Array.isArray(json) ? json : []);
  return list
    .map((raw) => {
      const title = getByPath(raw, mapping.title) || raw.title || "";
      const url = getByPath(raw, mapping.url) || raw.url || raw.link || "";
      if (!title || !url) return null;
      const desc = getByPath(raw, mapping.desc) || raw.desc || raw.description || "";
      const expiresRaw = getByPath(raw, mapping.expiresAt);
      const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;
      return {
        id: "api-" + hashCode(url),
        title: String(title).slice(0, 120),
        desc: stripHtml(desc).slice(0, 300),
        channel: getByPath(raw, mapping.channel) || source.channel || source.name,
        category: source.category || "其他",
        value: getByPath(raw, mapping.value) || guessValue(title, desc),
        url: String(url),
        expiresAt: Number.isNaN(new Date(expiresAt).getTime()) ? null : expiresAt,
        publishedAt: nowIso(),
        hot: getByPath(raw, mapping.hot) || 100,
        tags: [source.name]
      };
    })
    .filter(Boolean);
}

/* ---------- 羊毛相关性过滤（真实性第一道关卡） ---------- */

const WOOL_KEYWORDS = [
  "白嫖", "限免", "免费", "红包", "立减", "优惠", "折扣", "0元", "0 元", "1元", "1 元",
  "薅", "券", "羊毛", "送", "特价", "秒杀", "补贴", "签到", "返现", "现金", "提现",
  "半价", "低价", "省", "福利", "活动价", "新人", "买一送", "涨价回", "神券", "膨胀", "回血",
  // 外卖商家免单/抽实物活动专用词
  "免单", "霸王餐", "免费抽", "抽实物", "抽免单", "0.1元", "0.01元", "周边", "抽奖"
];
// 负面信号：看似优惠实为否定/辟谣语境
const NEGATIVE_PATTERNS = [/并不免费/, /不再免费/, /非免费/, /假优惠/, /谨防|警惕.*(免费|优惠)/, /取消.*(优惠|免费)/];
// 标题过短或纯符号的垃圾数据
const JUNK_TITLE = /^[\s\W\d]+$|^(转发|分享|快讯|图)$/i;

/**
 * 对单条羊毛打相关性分：标题命中 +2，描述命中 +1
 * 阈值 >=2 保留（至少标题命中一次，或描述命中两次），纯资讯推文被丢弃
 */
function woolScore(item) {
  const title = item.title || "";
  const desc = item.desc || "";
  if (JUNK_TITLE.test(title) || title.length < 6) return 0;
  if (NEGATIVE_PATTERNS.some((re) => re.test(title))) return 0;

  let score = 0;
  for (const kw of WOOL_KEYWORDS) {
    if (title.includes(kw)) score += 2;
    if (desc.includes(kw)) score += 1;
  }
  return score;
}

function filterRelevant(items) {
  return items.filter((it) => {
    const s = woolScore(it);
    if (s >= 2) {
      it._score = s;
      return true;
    }
    return false;
  });
}

/* ---------- 链接真实性验证（第二道关卡） ---------- */

const VERIFY_TIMEOUT = 10_000;
const VERIFY_CONCURRENCY = 5;

async function verifyOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: ctrl.signal,
      redirect: "follow"
    });
    try { if (res.body) await res.body.cancel(); } catch (_) { /* 忽略取消错误 */ }
    return res.ok; // 2xx 视为真实可达
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只验证「新入库」条目的链接可达性（已知旧数据不再重复验证，控制请求量）
 * 验证失败的条目直接丢弃，保证库内链接真实可点
 */
async function verifyLinks(items, knownUrls) {
  const fresh = items.filter((it) => it.url && /^https?:\/\//i.test(it.url) && !knownUrls.has(it.url));
  const kept = items.filter((it) => knownUrls.has(it.url));
  const queue = [...fresh];
  let verified = 0, dropped = 0;

  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      const ok = await verifyOne(it.url);
      if (ok) { it.verified = true; verified++; kept.push(it); }
      else { dropped++; console.warn(`   ✂ 丢弃不可达: [${it.channel}] ${String(it.title).slice(0, 40)}`); }
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));
  console.log(`   链接验证: ${verified} 条可达, ${dropped} 条不可达已丢弃`);
  return kept;
}

/* ---------- 主流程 ---------- */

async function main() {
  console.log("🐑 羊毛雷达抓取开始 @", nowIso());

  const sources = JSON.parse(readFileSync(SOURCES_PATH, "utf8")).sources || [];
  const enabled = sources.filter((s) => s.enabled !== false);
  console.log(`启用源 ${enabled.length}/${sources.length} 个`);

  // 读取现有数据，作为兜底与合并基底
  let existing = { items: [] };
  if (existsSync(DATA_PATH)) {
    try {
      existing = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    } catch (e) {
      console.warn("⚠️ 现有 deals.json 解析失败，将重建：", e.message);
    }
  }

  const fetched = [];
  const results = [];

  for (const source of enabled) {
    try {
      console.log(`→ 抓取 [${source.type}] ${source.name}: ${source.url}`);
      const text = await fetchWithTimeout(source.url);
      const items = source.type === "jsonapi" ? parseJsonApi(JSON.parse(text), source) : parseRss(text, source);
      // JSON API 源视为用户精选的羊毛数据，跳过关键词过滤；RSS 源必须过羊毛相关性关
      const filtered = source.type === "jsonapi" ? items : filterRelevant(items);
      console.log(`   ✓ 获得 ${items.length} 条，羊毛相关 ${filtered.length} 条（其余为无关推文，已丢弃）`);
      fetched.push(...filtered);
      results.push({ name: source.name, ok: true, count: filtered.length });
    } catch (err) {
      console.warn(`   ✗ 失败（跳过）: ${err.message}`);
      results.push({ name: source.name, ok: false, error: err.message });
    }
  }

  // 链接真实性验证：只验新入库条目，不可达的丢弃
  const knownUrls = new Set((existing.items || []).map((it) => it.url).filter(Boolean));
  console.log("→ 链接真实性验证…");
  const verifiedFetched = await verifyLinks(fetched, knownUrls);

  // 合并：验证过的新数据在前 + 保留旧的未过期条目；按 url 去重
  // 旧库清洗：历史抓取的 RSS 条目同样必须过羊毛相关性关；种子数据与带攻略条目豁免
  const existingKept = (existing.items || []).filter((it) => {
    if (String(it.id || "").startsWith("seed-") || it.guide || it.verified) return true;
    return woolScore(it) >= 2;
  });
  console.log(`→ 旧库清洗: ${existing.items.length} 条 → 保留 ${existingKept.length} 条羊毛相关`);

  const seen = new Set();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;

  const merged = [];
  for (const it of [...verifiedFetched, ...existingKept]) {
    const key = it.url || it.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 已明确过期且过期超 3 天的旧条目直接淘汰
    if (it.expiresAt) {
      const exp = new Date(it.expiresAt).getTime();
      if (!Number.isNaN(exp) && exp < Date.now() - 3 * 86400000) continue;
    }
    // RSS 旧数据按发布时间淘汰
    if (it.publishedAt && new Date(it.publishedAt).getTime() < cutoff) continue;
    merged.push(it);
  }

  const output = {
    updatedAt: nowIso(),
    source: "fetcher",
    stats: { sourcesOk: results.filter((r) => r.ok).length, sourcesTotal: enabled.length, fetched: verifiedFetched.length, linkVerified: true },
    items: merged.slice(0, MAX_ITEMS)
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`✅ 完成：写入 ${output.items.length} 条（本轮验证入库 ${verifiedFetched.length} 条，全部链接可达）`);
  console.log("源状态:", results.map((r) => `${r.name}${r.ok ? "✓" : "✗"}`).join(" "));
}

main().catch((err) => {
  console.error("❌ 抓取流程异常退出：", err);
  process.exit(1);
});
