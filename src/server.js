'use strict';

const path = require('path');
const express = require('express');
const {
  search,
  parseTarget,
  parseTolerance,
  validateGears,
  expandMatch,
  MAX_STAGES,
  MIN_DEVICES,
  MAX_DEVICES,
} = require('./search');
const { batchAssemble } = require('./batch');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

function serializeMatch(r) {
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
    results: results.map(serializeMatch),
  });
});

/* ------------------------------------------------------------------ */
/* 批量装配：2~3 台装置共用一份齿轮清单                                 */
/* ------------------------------------------------------------------ */

app.post('/api/batch', (req, res) => {
  const body = req.body || {};

  const rawDevices = body.devices;
  if (!Array.isArray(rawDevices) || rawDevices.length < MIN_DEVICES || rawDevices.length > MAX_DEVICES) {
    return res.status(400).json({
      error: `批量装配需要 ${MIN_DEVICES}～${MAX_DEVICES} 台装置（当前 ${Array.isArray(rawDevices) ? rawDevices.length : 0} 台）`,
    });
  }

  const devices = [];
  for (let i = 0; i < rawDevices.length; i++) {
    const row = rawDevices[i] || {};
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
    devices.push({ target, tolerance });
  }

  const checked = validateGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const out = batchAssemble(checked.gears, devices);

  res.json({
    maxStages: MAX_STAGES,
    deviceCount: devices.length,
    satisfiedCount: out.satisfiedCount,
    totalStages: out.totalStages,
    errorSum: out.errorSum ? serializeFrac(out.errorSum) : null,
    errorSumPercent: out.errorSum
      ? fracToDecimal({ num: out.errorSum.num * 100n, den: out.errorSum.den }, 6)
      : null,
    gears: checked.gears,
    devices: devices.map((d, i) => ({
      index: i,
      name: `装置 ${i + 1}`,
      target: serializeFrac(d.target),
      tolerance: serializeFrac(d.tolerance),
      totalMatches: out.perDevice[i].total,
      candidateCount: out.perDevice[i].maskCount,
      satisfied: out.picks[i] !== null,
      selection: out.picks[i] ? serializeMatch(expandMatch(checked.gears, out.picks[i])) : null,
    })),
    usedGears: checked.gears.filter((_, i) => out.usedMask & (1 << i)).map((g) => g.id),
    unusedGears: checked.gears.filter((_, i) => out.unusedMask & (1 << i)),
  });
});

app.listen(PORT, () => {
  console.log(`齿轮组选配服务已启动： http://localhost:${PORT}`);
});
