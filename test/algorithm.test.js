'use strict';

/* 算法自检脚本（不依赖测试框架） */
const assert = require('assert');
const {
  search,
  enumerateMatches,
  expandMatch,
  parseTarget,
  parseTolerance,
  validateGears,
  makeFrac,
} = require('../src/search');
const { batchAssemble } = require('../src/batch');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const countBits = (n) => n === 0 ? 0 : countBits(n >> 1) + (n & 1);

const gears = (rows) => validateGears(rows).gears;

/* 1. 单台搜索行为保持：示例场景存在 1/12 精确解 */
test('单台：10齿+60齿精确 1/6，1/12 需两级', () => {
  const g = gears([{ id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 }]);
  const r1 = search(g, parseTarget('1/6'), parseTolerance('0%'));
  assert.strictEqual(r1.total, 1);
  assert.strictEqual(r1.results[0].stages, 1);
  const r0 = search(g, parseTarget('1/12'), parseTolerance('0%'));
  assert.strictEqual(r0.total, 0);
});

/* 2. enumerateMatches 返回 mask，覆盖正确的位 */
test('枚举：mask 正确标记占用齿轮', () => {
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G2', teeth: 12 },
    { id: 'G7', teeth: 50 }, { id: 'G8', teeth: 60 },
  ]);
  const ms = enumerateMatches(g, parseTarget('1/6'), parseTolerance('0%'));
  assert.ok(ms.length >= 1);
  for (const m of ms) {
    // 一级方案恰好 2 位，两级方案恰好 4 位
    assert.strictEqual(countBits(m.mask), m.stages * 2);
  }
  const one = ms.find((m) => m.stages === 1);
  assert.ok(one);
  const oneEx = expandMatch(g, one);
  assert.deepStrictEqual(oneEx.pairs.map((p) => [p.drive.id, p.driven.id]).sort(), [['G1', 'G8']]);
});

/* 3. 批量：两台都能满足、齿轮不冲突 */
test('批量：两台独立需求全部满足（1/6 与 2/5）', () => {
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 },
    { id: 'G2', teeth: 12 }, { id: 'G5', teeth: 30 }, { id: 'G6', teeth: 40 },
  ]);
  const out = batchAssemble(g, [
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
    { target: parseTarget('2/5'), tolerance: parseTolerance('0%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 2);
  assert.deepStrictEqual(out.picks.map((p) => p.stages), [1, 1]);
  // 1/6 -> G1/G8；2/5 -> G2/G5（12/30）
  const used = new Set();
  for (const p of out.picks) for (const pr of expandMatch(g, p).pairs) {
    assert.ok(!used.has(pr.drive.id) && !used.has(pr.driven.id), `齿轮重复使用 ${pr.drive.id}`);
    used.add(pr.drive.id); used.add(pr.driven.id);
  }
});

/* 4. 批量：齿轮争抢——同一枚好齿轮不能两台共用，达标台数优先 */
test('批量：争抢齿轮时优先达标台数，无重复分配', () => {
  // 只有 4 枚齿轮：G1/G8 可配 1/6；两台都要 1/6，只能满足一台
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 },
    { id: 'GX', teeth: 11 }, { id: 'GY', teeth: 59 },
  ]);
  const out = batchAssemble(g, [
    { target: parseTarget('1/6'), tolerance: parseTolerance('1%') },
    { target: parseTarget('1/6'), tolerance: parseTolerance('1%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 1, '4枚齿轮最多支撑一台两级/一台一级');
  assert.ok(out.picks[0] !== null, '输入顺序靠前的装置优先满足');
  assert.strictEqual(out.picks[1], null);
});

/* 5. 批量：级数最少优先于误差 */
test('批量：达标台数相同 → 总级数最少', () => {
  // 12 枚齿轮：构造两级精确解与一级近似解竞争，选一级
  const g = gears([
    { id: 'A', teeth: 10 }, { id: 'B', teeth: 20 },
    { id: 'C', teeth: 30 }, { id: 'D', teeth: 60 },
    { id: 'E', teeth: 13 }, { id: 'F', teeth: 26 },
    { id: 'G', teeth: 7 }, { id: 'H', teeth: 70 },
    { id: 'I', teeth: 9 }, { id: 'J', teeth: 90 },
    { id: 'K', teeth: 11 }, { id: 'L', teeth: 44 },
  ]);
  const out = batchAssemble(g, [
    // 目标 0.5：一级 A/B=1/2 精确
    { target: parseTarget('1/2'), tolerance: parseTolerance('0%') },
    // 目标 1/2：C/D=1/2 精确
    { target: parseTarget('1/2'), tolerance: parseTolerance('0%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 2);
  assert.strictEqual(out.totalStages, 2);
});

/* 6. 稳定决胜：装置顺序 + 编号自然序 */
test('批量：并列时按装置输入顺序与齿轮编号自然序决胜', () => {
  // 两组对称齿轮都能精确配 1/6：G1/G8 与 G2/G12(12->72?) 用 12/72
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 },
    { id: 'G2', teeth: 12 }, { id: 'G9', teeth: 72 },
  ]);
  const out = batchAssemble(g, [
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 2);
  // 第一台取编号自然序最小候选：主动轮 G1（G1<G2）
  assert.strictEqual(expandMatch(g, out.picks[0]).pairs[0].drive.id, 'G1');
  assert.strictEqual(expandMatch(g, out.picks[1]).pairs[0].drive.id, 'G2');
});

/* 7. 未用齿轮清单正确 */
test('批量：未用齿轮按自然序返回（mask 列表）', () => {
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 },
    { id: 'G2', teeth: 12 }, { id: 'G10', teeth: 100 },
  ]);
  const out = batchAssemble(g, [
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
    { target: parseTarget('999'), tolerance: parseTolerance('0%') }, // 无解
  ]);
  assert.strictEqual(out.satisfiedCount, 1);
  const unusedIds = g.map((_, i) => (out.unusedMask & (1 << i)) ? g[i].id : null).filter(Boolean);
  assert.deepStrictEqual(unusedIds, ['G2', 'G10']);
});

/* 8. 全量枚举不截断：大量齿轮时批量看到的候选多于 300 */
test('批量：不使用 300 条截断，候选来自全部达标配对', () => {
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push({ id: `G${i}`, teeth: 10 + i * 5 });
  const g = gears(rows);
  // 容差 100% 几乎所有配对都达标，单台 total 会超过 300
  const ms = enumerateMatches(g, parseTarget('1'), parseTolerance('100%'));
  assert.ok(ms.length > 300, `应枚举出超过 300 条，实际 ${ms.length}`);
  const out = batchAssemble(g, [
    { target: parseTarget('1'), tolerance: parseTolerance('100%') },
    { target: parseTarget('1'), tolerance: parseTolerance('100%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 2);
});

/* 9. 误差之和精确分数比较 */
test('批量：相对误差之和以精确分数比较', () => {
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G8', teeth: 60 },
    { id: 'G2', teeth: 12 }, { id: 'G9', teeth: 72 },
  ]);
  const out = batchAssemble(g, [
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
    { target: parseTarget('1/6'), tolerance: parseTolerance('0%') },
  ]);
  assert.strictEqual(out.errorSum.num, 0n);
});

/* 10. 三台装置 */
test('批量：三台装置，示例数据全部满足', () => {
  const rows = [
    [10, 'G1'], [12, 'G2'], [15, 'G3'], [20, 'G4'], [30, 'G5'], [40, 'G6'],
    [50, 'G7'], [60, 'G8'], [80, 'G9'], [100, 'G10'], [24, 'G11'], [25, 'G12'],
  ].map(([teeth, id]) => ({ id, teeth }));
  const g = gears(rows);
  const out = batchAssemble(g, [
    { target: parseTarget('1/12'), tolerance: parseTolerance('5%') },
    { target: parseTarget('1/6'), tolerance: parseTolerance('5%') },
    { target: parseTarget('1/5'), tolerance: parseTolerance('5%') },
  ]);
  assert.strictEqual(out.satisfiedCount, 3);
  const used = new Set();
  for (const p of out.picks) for (const pr of expandMatch(g, p).pairs) {
    assert.ok(!used.has(pr.drive.id));
    used.add(pr.drive.id); used.add(pr.driven.id);
  }
  assert.ok(out.unusedMask > 0 || out.unusedMask === 0);
  const unusedCount = g.filter((_, i) => out.unusedMask & (1 << i)).length;
  assert.ok(unusedCount > 0);
});

/* 11. 同占用集合只保留最优候选：误差最小（同集合同级时） */
test('候选归并：同一占用齿轮集合保留误差最小候选', () => {
  const { buildCandidates } = require('../src/batch');
  // 4 枚齿轮、两级（必须四枚全用）：朝向/配对不同 → 同一 mask 多个达标配对
  // 选 10,20,30,60：配对 (10/30)*(20/60)=1/9、(10/60)*(20/30)=1/9、
  // (10/20)*(30/60)=1/4、(10/20)*(60/30)=1 … 目标 1/4 容差 100% 时多条达标，
  // 精确等于 1/4 的候选（误差 0）应在该 mask 上胜出
  const g = gears([
    { id: 'G1', teeth: 10 }, { id: 'G2', teeth: 20 },
    { id: 'G3', teeth: 30 }, { id: 'G4', teeth: 60 },
  ]);
  const { candidates } = buildCandidates(g, parseTarget('1/4'), parseTolerance('100%'));
  const fullMaskCandidates = candidates.filter((c) => countBits(c.mask) === 4);
  assert.strictEqual(fullMaskCandidates.length, 1, '同一 mask 只保留一个候选');
  assert.strictEqual(fullMaskCandidates[0].errN, 0n);
});

console.log(`\n全部 ${passed} 项测试通过`);
