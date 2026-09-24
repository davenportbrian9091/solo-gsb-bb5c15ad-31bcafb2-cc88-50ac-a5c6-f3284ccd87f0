'use strict';

/**
 * 齿轮组选配核心算法（精确分数计算，基于 BigInt）
 *
 * 每级传动选一枚主动轮和一枚从动轮：
 *   实际输出/输入转速比 = ∏ (主动轮齿数 / 从动轮齿数)
 * 一枚齿轮在整套方案中至多使用一次。
 *
 * 搜索范围：1~3 级；方案排序：级数少 → 相对误差小 → 齿轮编号序列字典序（自然序）。
 */

/** 最大搜索级数 / 单次返回方案上限 / 单个齿轮库上限 */
const MAX_STAGES = 3;
const RESULT_LIMIT = 300;
const MAX_GEARS = 12;
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
/* 组合枚举：从 n 枚齿轮中选 2k 枚的全部组合（按索引升序）              */
/* ------------------------------------------------------------------ */

function* combinations(n, k) {
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  yield idx.slice();
  while (true) {
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    yield idx.slice();
  }
}

/**
 * 在给定 2k 枚齿轮（subset 为按索引升序的下标数组）上枚举全部“有向配对”。
 * 每枚齿轮恰好出现一次；每对按 (最小未用轮, 其它未用轮) 锚定，两个朝向
 * （谁主动/谁从动）都枚举，保证不重不漏。
 *
 * 返回 [{ drive: gear, driven: gear }] × k
 */
function* pairings(gears, subset) {
  const pair = new Array(subset.length / 2);

  function* rec(remaining, depth) {
    if (remaining.size === 0) {
      yield pair.slice();
      return;
    }
    // 剩余中自然序最小者作为锚点，消除“同一组对”的排列重复
    let anchor = null;
    for (const gi of remaining) {
      if (anchor === null || naturalCmp(gears[gi].id, gears[anchor].id) < 0) anchor = gi;
    }
    for (const partner of remaining) {
      if (partner === anchor) continue;
      const next = new Set(remaining);
      next.delete(anchor);
      next.delete(partner);
      pair[depth] = { driveIndex: anchor, drivenIndex: partner };
      yield* rec(next, depth + 1);
      pair[depth] = { driveIndex: partner, drivenIndex: anchor };
      yield* rec(next, depth + 1);
    }
  }

  yield* rec(new Set(subset), 0);
}

/* ------------------------------------------------------------------ */
/* 主搜索                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<{id:string,teeth:number}>} gears 现有齿轮（2~12 枚，编号唯一）
 * @param {{num:bigint,den:bigint}} target 目标输出转速比（正分数）
 * @param {{num:bigint,den:bigint}} tolerance 允许相对误差（非负分数）
 * @returns {{results:Array,total:number,truncated:boolean}}
 */
function search(gears, target, tolerance) {
  /** 扁平编号序列，用于方案去重（同一配对集合+朝向，仅对顺序不同，只保留一条） */
  const seen = new Set();
  /** @type {Array<{stages:number,error:{num:bigint,den:bigint}}>} */
  const matches = [];

  for (let k = 1; k <= MAX_STAGES; k++) {
    if (2 * k > gears.length) break;

    for (const subset of combinations(gears.length, 2 * k)) {
      for (const rawPairs of pairings(gears, subset)) {
        // 各级累计实际转速比（精确分数）
        let ratio = { num: 1n, den: 1n };
        const pairs = rawPairs.map((p) => {
          const d = gears[p.driveIndex];
          const w = gears[p.drivenIndex];
          ratio = mulFrac(ratio, makeFrac(BigInt(d.teeth), BigInt(w.teeth)));
          return {
            drive: { id: d.id, teeth: d.teeth },
            driven: { id: w.id, teeth: w.teeth },
            stageRatio: { num: BigInt(d.teeth), den: BigInt(w.teeth) },
          };
        });

        // 相对误差 = |ratio - target| / target（精确分数）
        const diff = ratio.num * target.den >= target.num * ratio.den
          ? makeFrac(ratio.num * target.den - target.num * ratio.den, ratio.den * target.den)
          : makeFrac(target.num * ratio.den - ratio.num * target.den, ratio.den * target.den);
        const error = makeFrac(diff.num * target.den, diff.den * target.num);

        // |diff|/target <= tolerance
        if (error.num * tolerance.den > tolerance.num * error.den) continue;

        // 规范化：按主动轮编号自然序排列各级，使“仅级顺序不同”的方案归一
        pairs.sort((a, b) => naturalCmp(a.drive.id, b.drive.id));
        const flatIds = pairs.map((p) => `${p.drive.id}>${p.driven.id}`).join('|');
        if (seen.has(flatIds)) continue;
        seen.add(flatIds);

        matches.push({
          stages: k,
          ratio,
          error,
          pairs,
          flatIds: pairs.map((p) => [p.drive.id, p.driven.id]),
        });
      }
    }
  }

  // 排序：级数最少 → 误差最小 → 齿轮编号序列（各级 主动,从动 依次比较）
  matches.sort((a, b) => {
    if (a.stages !== b.stages) return a.stages - b.stages;
    const ea = a.error.num * b.error.den;
    const eb = b.error.num * a.error.den;
    if (ea !== eb) return ea < eb ? -1 : 1;
    for (let i = 0; i < Math.max(a.flatIds.length, b.flatIds.length); i++) {
      const x = a.flatIds[i];
      const y = b.flatIds[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const c1 = naturalCmp(x[0], y[0]);
      if (c1) return c1;
      const c2 = naturalCmp(x[1], y[1]);
      if (c2) return c2;
    }
    return 0;
  });

  const total = matches.length;
  return {
    total,
    truncated: total > RESULT_LIMIT,
    results: matches.slice(0, RESULT_LIMIT),
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
  search,
  parseTarget,
  parseTolerance,
  validateGears,
};
