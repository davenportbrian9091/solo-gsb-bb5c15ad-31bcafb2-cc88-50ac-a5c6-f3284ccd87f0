'use strict';

const path = require('path');
const express = require('express');
const {
  search,
  parseTarget,
  parseTolerance,
  validateGears,
  MAX_STAGES,
} = require('./search');
const { planBatch } = require('./batch');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/** 友好访问批量装配页：/batch → /batch.html */
app.get('/batch', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'batch.html'));
});

/** BigInt 分数安全转为有限小数（用于前端展示） */
function fracToDecimal(frac, digits = 10) {
  const neg = frac.num < 0n;
  let num = frac.num < 0n ? -frac.num : frac.num;
  const intPart = num / frac.den;
  let rem = num % frac.den;
  let out = intPart.toString();
  if (digits > 0) {
    let fracStr = '';
    for (let i = 0; i < digits && rem > 0n; i++) {
      rem *= 10n;
      fracStr += (rem / frac.den).toString();
      rem %= frac.den;
    }
    if (fracStr) out += `.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

function serializeFrac(f) {
  return { num: f.num.toString(), den: f.den.toString(), decimal: fracToDecimal(f) };
}

function serializeSolution(r) {
  return {
    stages: r.stages,
    ratio: serializeFrac(r.ratio),
    error: serializeFrac(r.error),
    errorPercent: fracToDecimal({ num: r.error.num * 100n, den: r.error.den }, 6),
    pairs: r.pairs.map((p) => ({
      drive: p.drive,
      driven: p.driven,
      stageRatio: serializeFrac(p.stageRatio),
    })),
  };
}

app.post('/api/search', (req, res) => {
  const body = req.body || {};

  const target = parseTarget(String(body.target ?? ''));
  if (!target) {
    return res.status(400).json({ error: '目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）' });
  }

  const tolerance = parseTolerance(String(body.tolerance ?? ''));
  if (!tolerance) {
    return res.status(400).json({ error: '允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）' });
  }

  const checked = validateGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const { total, truncated, results } = search(checked.gears, target, tolerance);

  res.json({
    target: serializeFrac(target),
    tolerance: serializeFrac(tolerance),
    maxStages: MAX_STAGES,
    total,
    truncated,
    count: results.length,
    results: results.map(serializeSolution),
  });
});

app.post('/api/batch', (req, res) => {
  const body = req.body || {};

  const checked = validateGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  if (!Array.isArray(body.devices) || body.devices.length < 2 || body.devices.length > 3) {
    return res.status(400).json({ error: '批量装配需输入 2～3 台装置' });
  }

  const devices = [];
  for (let i = 0; i < body.devices.length; i++) {
    const row = body.devices[i];
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ error: `第 ${i + 1} 台装置数据格式不正确` });
    }
    const target = parseTarget(String(row.target ?? ''));
    if (!target) {
      return res.status(400).json({
        error: `第 ${i + 1} 台装置的目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）`,
      });
    }
    const tolerance = parseTolerance(String(row.tolerance ?? ''));
    if (!tolerance) {
      return res.status(400).json({
        error: `第 ${i + 1} 台装置的允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）`,
      });
    }
    const name = String(row.name ?? '').trim() || `装置 ${i + 1}`;
    if (name.length > 30) {
      return res.status(400).json({ error: `第 ${i + 1} 台装置名称不能超过 30 个字符` });
    }
    devices.push({ name, target, tolerance });
  }

  // 基于全部达标方案分配（不截断 300 条）
  const plan = planBatch(checked.gears, devices);

  const usedIds = new Set();
  for (const pick of plan.picks) {
    if (pick) for (const id of pick.gearIds) usedIds.add(id);
  }
  const unusedGears = checked.gears.filter((g) => !usedIds.has(g.id));

  res.json({
    maxStages: MAX_STAGES,
    deviceCount: devices.length,
    matchedCount: plan.matchedCount,
    totalStages: plan.totalStages,
    errorSum: serializeFrac(plan.errorSum),
    errorSumPercent: fracToDecimal({ num: plan.errorSum.num * 100n, den: plan.errorSum.den }, 6),
    unusedGears,
    devices: devices.map((d, i) => ({
      name: d.name,
      target: serializeFrac(d.target),
      tolerance: serializeFrac(d.tolerance),
      totalMatches: plan.totalMatches[i],
      candidateCount: plan.candidateCounts[i],
      matched: !!plan.picks[i],
      solution: plan.picks[i] ? serializeSolution(plan.picks[i]) : null,
    })),
  });
});

app.listen(PORT, () => {
  console.log(`齿轮组选配服务已启动： http://localhost:${PORT}`);
  console.log(`  单台选配： http://localhost:${PORT}/`);
  console.log(`  批量装配： http://localhost:${PORT}/batch`);
});
