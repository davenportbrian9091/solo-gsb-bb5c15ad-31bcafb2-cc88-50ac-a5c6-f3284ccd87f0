'use strict';

/**
 * 齿轮组选配核心算法（精确分数计算，基于 BigInt）
 *
 * 每级传动选一枚主动轮和一枚从动轮：
 *   实际输出/输入转速比 = ∏ (主动轮齿数 / 从动轮齿数)
 * 一枚齿轮在整套方案中至多使用一次。
 *
 * 搜索范围：1~3 级；方案排序：级数少 → 相对误差小 → 齿轮编号序列字典序（自然序）。
 *
 * enumerateMatches() 枚举“全部”达标方案并附带占用齿轮位图（mask），
 * 供单台搜索（search，最多返回 300 条）与批量装配（batchAssemble）共用。
 */

/** 最大搜索级数 / 单次返回方案上限 / 单个齿轮库上限 */
const MAX_STAGES = 3;
const RESULT_LIMIT = 300;
const MAX_GEARS = 12;
/** 批量装配允许的装置数量范围 */
const MIN_DEVICES = 2;
const MAX_DEVICES = 3;
const MIN_TEETH = 1;
const MAX_TEETH = 100000;

/* ------------------------------------------------------------------ */
/* 精确分数工具                                                        */
/* ------------------------------------------------------------------ */

function gcdBig(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function makeFrac(num, den) {
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcdBig(num, den);
  return { num: num / g, den: den / g };
}

function mulFrac(a, b) {
  return makeFrac(a.num * b.num, a.den * b.den);
}

function addFrac(a, b) {
  return makeFrac(a.num * b.den + b.num * a.den, a.den * b.den);
}

/** 比较两个正分数：a<b 返回 -1，相等 0，a>b 返回 1 */
function cmpFrac(a, b) {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs === rhs ? 0 : 1;
}

/**
 * 解析十进制数字串（允许前导符号、小数点），返回约分分数。
 * 不接受科学计数法。
 */
function parseDecimal(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^([+-]?)(?:(\d+)\.(\d+)|(\d+)\.?|\.(\d+))$/.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? m[4] ?? '';
  const fracPart = m[3] ?? m[5] ?? '';
  const den = 10n ** BigInt(fracPart.length);
  const num = (BigInt(intPart || '0') * den + BigInt(fracPart || '0')) * sign;
  if (num === 0n) return { num: 0n, den: 1n };
  return makeFrac(num, den);
}

/**
 * 解析目标转速比：支持小数（12、12.5、0.0833）或形如 1/12 的分数。
 * 必须为正数。
 */
function parseTarget(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return null;
    const n = parseDecimal(parts[0]);
    const d = parseDecimal(parts[1]);
    if (!n || !d || n.num <= 0n || d.num <= 0n) return null;
    return makeFrac(n.num * d.den, n.den * d.num);
  }
  const v = parseDecimal(s);
  if (!v || v.num <= 0n) return null;
  return v;
}

/**
 * 解析允许相对误差：支持小数（0.01）或百分数（1%、0.5%），非负。
 * 返回分数 tol（相对误差 = |实际-目标| / 目标 <= tol）。
 */
function parseTolerance(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
    if (!s) return null;
  }
  const v = parseDecimal(s);
  if (!v || v.num < 0n) return null;
  return percent ? makeFrac(v.num, v.den * 100n) : v;
}

/* ------------------------------------------------------------------ */
/* 编号自然序（G2 < G10）                                              */
/* ------------------------------------------------------------------ */

function naturalCmp(a, b) {
  const na = String(a);
  const nb = String(b);
  const re = /\d+|\D+/g;
  const ta = na.match(re) || [];
  const tb = nb.match(re) || [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const da = /^\d+$/.test(ta[i]);
    const db = /^\d+$/.test(tb[i]);
    if (da && db) {
      const da2 = ta[i].replace(/^0+/, '') || '0';
      const db2 = tb[i].replace(/^0+/, '') || '0';
      if (da2.length !== db2.length) return da2.length < db2.length ? -1 : 1;
      if (da2 !== db2) return da2 < db2 ? -1 : 1;
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
    } else {
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
    }
  }
  return ta.length - tb.length || (na < nb ? -1 : na > nb ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* 全量达标方案枚举（批量装配不允许截断，因此必须拿到全部方案）          */
/* ------------------------------------------------------------------ */

/**
 * 枚举 1~3 级内全部达标方案，不做数量截断。
 * 每个方案附带：
 *   - mask：入选齿轮位图（gears 已按编号自然序排序，位 i 对应 gears[i]）
 *   - flatIds / flatIdx：按主动轮编号归一化后的级序列
 *
 * 单个增量 DFS 完成枚举（used 标记数组，无集合/生成器开销）：锚点恒为当前
 * “既未入选也未决定不用”的最小下标齿轮。每轮枚举两种决策：
 *   1) 锚点不参与方案（标记后继续找下一锚点）——因此可枚举任意齿轮子集；
 *   2) 锚点与任一更大的未用齿轮配成新一级，枚举两个朝向（锚主动 / 锚从动）。
 * 每追加一对就按“更深一级”判定一次，故同一配对路径上依次产出 1/2/3 级
 * 方案。各级锚点下标严格递增，“仅级顺序不同”的方案被结构性消除，无需事后
 * 排序或去重。
 *
 * 为控制上万条命中时的对象开销，返回的是“紧凑记录”：
 *   { stages, rN, rD, errN, errD, idx: Int8Array(2*stages), mask }
 * 其中 idx 按 (主动下标, 从动下标) 顺序排列、比较器可直接使用；rN/rD 为未
 * 约分总速比，errN/errD 为未约分相对误差。需要展示时用 expandMatch 展开。
 *
 * @returns {Array<object>}
 */
function enumerateMatches(gears, target, tolerance) {
  const matches = [];
  const n = gears.length;
  const teethArr = gears.map((g) => BigInt(g.teeth));
  const bit = new Array(n);
  for (let i = 0; i < n; i++) bit[i] = 1 << i;

  const tN = target.num;
  const tD = target.den;
  const tolN = tolerance.num;
  const tolD = tolerance.den;

  // used[i]=1 表示齿轮 i 已入选方案或已决定不使用（即不再参与后续锚点选择）
  const used = new Uint8Array(n);
  // path 记录已选各级 {driveIndex, drivenIndex}；速比/位图增量维护
  const path = [];
  /** 已记录方案的归一化标识集合。
   *  朝向不同的锚点枚举可能得到同一配对方案（如某轮既被锚为从动、又在另一
   *  路径中被锚为主动），需去重。齿轮不超过 12 枚，用每对 (主动下标,从动
   *  下标) 各 4 位拼成数值令牌、排序后按进制组合即可无碰撞地标识方案
   *  （12 枚、3 级时 12 个 4 位 nibble，仍在安全整数范围内）。 */
  const seen = new Set();

  /** 判定当前 path 是否达标，达标则记录一条紧凑方案 */
  function record(usedMask, rN, rD) {
    const stages = path.length;
    // 相对误差 = |rN/rD - tN/tD| / (tN/tD) = |rN*tD - tN*rD| / (tN*rD)
    const lhs = rN * tD;
    const rhs = tN * rD;
    const gap = lhs >= rhs ? lhs - rhs : rhs - lhs;
    if (gap * tolD > tolN * rD) return;

    // 归一化去重：每级令牌 = 主动下标*16 + 从动下标（各 4 位，MAX_GEARS≤12）
    const toks = new Array(stages);
    for (let s = 0; s < stages; s++) {
      toks[s] = path[s].driveIndex * 16 + path[s].drivenIndex;
    }
    toks.sort((x, y) => x - y);
    let dedupKey = 0;
    for (let s = 0; s < stages; s++) dedupKey = dedupKey * 256 + toks[s];
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    // 紧凑下标序列（已按主动轮自然序：各级锚点即主动轮，主动轮下标严格递增；
    // 朝向二时锚点为从动轮，该级主动轮是更大的 partner，需在去重后展开时排序）。
    // 比较器需要“按主动轮归一化”的序列，这里直接存 path 原始顺序，
    // 用 sortKey（去重令牌反解、已排序）承载稳定顺序。
    const idx = new Int8Array(stages * 2);
    for (let s = 0; s < stages; s++) {
      idx[s * 2] = path[s].driveIndex;
      idx[s * 2 + 1] = path[s].drivenIndex;
    }
    matches.push({
      stages,
      rN,
      rD,
      errN: gap,
      errD: tN * rD,
      idx,
      mask: usedMask,
    });
  }

  /**
   * @param from {number} 锚点搜索起点（小于 from 的均已处理）
   * @param usedMask {number} 入选齿轮位图
   */
  function dfs(from, rN, rD, usedMask) {
    if (path.length >= 1) record(usedMask, rN, rD);
    if (path.length >= MAX_STAGES) return;

    let anchor = -1;
    for (let i = from; i < n; i++) {
      if (!used[i]) { anchor = i; break; }
    }
    if (anchor === -1) return;

    // 决策一：锚点不参与本方案
    used[anchor] = 1;
    dfs(anchor + 1, rN, rD, usedMask);
    used[anchor] = 0;

    // 决策二：锚点与任一更大的未用齿轮配成新一级（两个朝向）
    for (let partner = anchor + 1; partner < n; partner++) {
      if (used[partner]) continue;
      const newMask = usedMask | bit[anchor] | bit[partner];
      used[anchor] = 1;
      used[partner] = 1;

      path.push({ driveIndex: anchor, drivenIndex: partner });
      dfs(anchor + 1, rN * teethArr[anchor], rD * teethArr[partner], newMask);
      path.pop();

      path.push({ driveIndex: partner, drivenIndex: anchor });
      dfs(anchor + 1, rN * teethArr[partner], rD * teethArr[anchor], newMask);
      path.pop();

      used[anchor] = 0;
      used[partner] = 0;
    }
  }

  dfs(0, 1n, 1n, 0);
  return matches;
}

/**
 * 把紧凑记录展开为对外方案对象（含约分分数与配对明细）。
 */
function expandMatch(gears, m) {
  const ratio = makeFrac(m.rN, m.rD);
  const error = makeFrac(m.errN, m.errD);
  // 按主动轮编号自然序归一化各级（与历史单台搜索排序口径一致）
  const order = [];
  for (let s = 0; s < m.stages; s++) order.push(s);
  order.sort((a, b) => (m.idx[a * 2] !== m.idx[b * 2]
    ? m.idx[a * 2] - m.idx[b * 2]
    : m.idx[a * 2 + 1] - m.idx[b * 2 + 1]));
  const pairs = new Array(m.stages);
  const flatIds = new Array(m.stages);
  const flatIdx = new Array(m.stages);
  order.forEach((s, pos) => {
    const di = m.idx[s * 2];
    const wi = m.idx[s * 2 + 1];
    pairs[pos] = {
      drive: { id: gears[di].id, teeth: gears[di].teeth },
      driven: { id: gears[wi].id, teeth: gears[wi].teeth },
      stageRatio: { num: BigInt(gears[di].teeth), den: BigInt(gears[wi].teeth) },
    };
    flatIds[pos] = [gears[di].id, gears[wi].id];
    flatIdx[pos] = [di, wi];
  });
  return { stages: m.stages, ratio, error, pairs, flatIds, flatIdx, mask: m.mask };
}

/**
 * 紧凑记录比较（与单台搜索排序一致）：
 * 级数少 → 相对误差小 → 归一化后的各级 (主动轮, 从动轮) 下标序。
 * 为避免每次比较都排序，使用惰性缓存字段 _key（归一化令牌数组）。
 * @returns {-1|0|1}
 */
function normalizedKey(m) {
  if (m._key) return m._key;
  const toks = new Array(m.stages);
  for (let s = 0; s < m.stages; s++) toks[s] = m.idx[s * 2] * 16 + m.idx[s * 2 + 1];
  toks.sort((x, y) => x - y);
  m._key = toks;
  return toks;
}

function compareMatches(a, b) {
  if (a.stages !== b.stages) return a.stages < b.stages ? -1 : 1;
  // 未约分误差交叉相乘比较
  const lhs = a.errN * b.errD;
  const rhs = b.errN * a.errD;
  if (lhs !== rhs) return lhs < rhs ? -1 : 1;
  const ka = normalizedKey(a);
  const kb = normalizedKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 单台搜索                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<{id:string,teeth:number}>} gears 现有齿轮（2~12 枚，编号唯一）
 * @param {{num:bigint,den:bigint}} target 目标输出转速比（正分数）
 * @param {{num:bigint,den:bigint}} tolerance 允许相对误差（非负分数）
 * @returns {{results:Array,total:number,truncated:boolean}}
 */
function search(gears, target, tolerance) {
  const matches = enumerateMatches(gears, target, tolerance);
  matches.sort(compareMatches);

  const total = matches.length;
  return {
    total,
    truncated: total > RESULT_LIMIT,
    results: matches.slice(0, RESULT_LIMIT).map((m) => expandMatch(gears, m)),
  };
}

/**
 * 校验并规范化输入齿轮列表。
 * @returns {{ok:true, gears:Array}|{ok:false,error:string}}
 */
function validateGears(input) {
  if (!Array.isArray(input)) return { ok: false, error: '齿轮列表格式不正确' };
  if (input.length < 2 || input.length > MAX_GEARS) {
    return { ok: false, error: `齿轮数量需在 2~${MAX_GEARS} 枚之间（当前 ${input.length} 枚）` };
  }
  const gears = [];
  const ids = new Set();
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') return { ok: false, error: `第 ${i + 1} 行齿轮数据格式不正确` };
    const id = String(row.id ?? '').trim();
    if (!id) return { ok: false, error: `第 ${i + 1} 行缺少齿轮编号` };
    if (ids.has(id)) return { ok: false, error: `齿轮编号重复：${id}` };
    ids.add(id);
    const teeth = Number(row.teeth);
    if (!Number.isInteger(teeth) || teeth < MIN_TEETH || teeth > MAX_TEETH) {
      return { ok: false, error: `齿轮 ${id} 的齿数需为 ${MIN_TEETH}~${MAX_TEETH} 的整数` };
    }
    gears.push({ id, teeth });
  }
  // 按编号自然序排列，保证枚举与结果稳定
  gears.sort((a, b) => naturalCmp(a.id, b.id));
  return { ok: true, gears };
}

module.exports = {
  MAX_STAGES,
  RESULT_LIMIT,
  MAX_GEARS,
  MIN_DEVICES,
  MAX_DEVICES,
  search,
  enumerateMatches,
  expandMatch,
  compareMatches,
  naturalCmp,
  makeFrac,
  mulFrac,
  addFrac,
  cmpFrac,
  parseTarget,
  parseTolerance,
  validateGears,
};
