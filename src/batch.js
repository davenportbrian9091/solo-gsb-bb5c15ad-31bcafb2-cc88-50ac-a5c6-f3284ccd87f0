'use strict';

/**
 * 批量装配核心算法。
 *
 * 输入 2~3 台装置（各自目标速比、容差）与一份共用齿轮清单。单台规则沿用
 * search.enumerateMatches：1~3 级、每级两轮、精确分数判定。
 *
 * 流程：
 *   1. 对每台枚举“全部”达标配对（不做 300 条截断），按“占用齿轮集合 (mask)”
 *      分组，同一集合只保留最优候选（级数 → 相对误差 → 编号自然序）。
 *   2. 按装置输入顺序逐台做掩码动态规划，求互不冲突（任一实物齿轮整批至多
 *      使用一次）的组合：
 *        先最大化达标台数，再最小化总级数，再最小化相对误差之和；
 *        最后按装置顺序、齿轮编号自然序稳定决胜。
 *
 * 候选记录是 search.enumerateMatches 返回的“紧凑记录”（idx/rN/rD/errN/errD），
 * 仅在最终序列化时展开为配对明细，避免上万候选 × 多对象的分配开销。
 *
 * 同一前缀下聚合指标相同的部分方案只保留字典序最靠前的一条——若当前层
 * 指标一致，被淘汰方案在后续任意层都不可能反超（达标数、级数、误差只增不
 * 减且后续加入的候选完全相同），故该剪枝安全。
 */

const {
  enumerateMatches,
  compareMatches,
  makeFrac,
} = require('./search');

/**
 * 为单台装置整理候选：同一占用齿轮集合只保留最优候选。
 * @returns {{candidates: Array<CompactMatch>, total: number}}
 *   candidates 按 (级数, 误差, 编号自然序) 稳定排序；total 为全部达标配对数
 */
function buildCandidates(gears, target, tolerance) {
  const matches = enumerateMatches(gears, target, tolerance);
  matches.sort(compareMatches);

  const bestByMask = new Map();
  for (const m of matches) {
    if (!bestByMask.has(m.mask)) bestByMask.set(m.mask, m);
  }
  // matches 已排序，Map 插入顺序即排序顺序，values() 天然稳定有序
  return { candidates: Array.from(bestByMask.values()), total: matches.length };
}

/**
 * 决胜字典序中单台的比较：“未达标”排在“达标”之后（优先让靠前的装置达标）；
 * 都达标时比较选中候选的 (级数, 误差, 编号自然序)。
 */
function compareChoiceAt(pickA, pickB) {
  if (pickA === null && pickB === null) return 0;
  if (pickA === null) return 1;
  if (pickB === null) return -1;
  return compareMatches(pickA, pickB);
}

/**
 * 完整方案比较（聚合指标 + 稳定决胜）。
 * a/b: { count, stages, errN:bigint, errD:bigint, picks: Array<CompactMatch|null> }
 */
function compareStates(a, b) {
  if (a.count !== b.count) return a.count > b.count ? -1 : 1;
  if (a.stages !== b.stages) return a.stages < b.stages ? -1 : 1;
  // 相对误差之和（未约分 BigInt 交叉相乘）
  const lhs = a.errN * b.errD;
  const rhs = b.errN * a.errD;
  if (lhs !== rhs) return lhs < rhs ? -1 : 1;
  for (let i = 0; i < a.picks.length; i++) {
    const c = compareChoiceAt(a.picks[i], b.picks[i]);
    if (c) return c;
  }
  return 0;
}

/**
 * @param {Array<{id:string,teeth:number}>} gears 共用齿轮（已按编号自然序排序）
 * @param {Array<{target:frac,tolerance:frac}>} devices 装置（按输入顺序）
 */
function batchAssemble(gears, devices) {
  // 1) 每台：全量达标配对 → 按占用集合保留最优候选
  const built = devices.map((d) => buildCandidates(gears, d.target, d.tolerance));
  const candidateLists = built.map((b) => b.candidates);

  // 统计信息：全部达标配对数、按占用集合去重后的候选数
  const perDevice = built.map((b) => ({
    total: b.total,
    maskCount: b.candidates.length,
  }));

  // 2) 掩码动态规划：dp: mask -> 最优部分状态
  //    errN/errD 为各候选“未约分误差”之和的分子/分母（同分母累加）
  let dp = new Map([
    [0, { used: 0, count: 0, stages: 0, errN: 0n, errD: 1n, picks: [] }],
  ]);

  for (let di = 0; di < devices.length; di++) {
    const candidates = candidateLists[di];
    const next = new Map();

    const consider = (state) => {
      const old = next.get(state.used);
      if (old === undefined || compareStates(state, old) < 0) next.set(state.used, state);
    };

    for (const state of dp.values()) {
      // 分支一：本台不达标（跳过）
      consider({
        used: state.used,
        count: state.count,
        stages: state.stages,
        errN: state.errN,
        errD: state.errD,
        picks: state.picks.concat(null),
      });

      // 分支二：选择一个齿轮不冲突的候选
      for (const cand of candidates) {
        if (state.used & cand.mask) continue;
        // 误差之和：state.errN/state.errD + cand.errN/cand.errD（state.errD 是
        // 之前各候选 errD 的乘积，这里直接交叉相乘累加）
        consider({
          used: state.used | cand.mask,
          count: state.count + 1,
          stages: state.stages + cand.stages,
          errN: state.errN * cand.errD + cand.errN * state.errD,
          errD: state.errD * cand.errD,
          picks: state.picks.concat(cand),
        });
      }
    }

    dp = next;
  }

  // 3) 在全部最终状态中取全局最优
  let best = null;
  for (const state of dp.values()) {
    if (best === null || compareStates(state, best) < 0) best = state;
  }

  // 4) 未使用齿轮位图（按齿轮清单顺序，即位图自然序）
  const allMask = gears.reduce((mask, _, i) => mask | (1 << i), 0);
  const unusedMask = allMask & ~best.used;

  return {
    satisfiedCount: best.count,
    totalStages: best.stages,
    errorSum: best.count > 0 ? makeFrac(best.errN, best.errD) : null,
    picks: best.picks,
    perDevice,
    usedMask: best.used,
    unusedMask,
  };
}

module.exports = {
  batchAssemble,
  buildCandidates,
};
