'use strict';

const deviceBox = document.getElementById('device-rows');
const rowsBox = document.getElementById('gear-rows');
const form = document.getElementById('batch-form');
const formError = document.getElementById('form-error');
const resultPanel = document.getElementById('result-panel');
const resultSummary = document.getElementById('result-summary');
const optNote = document.getElementById('batch-opt-note');
const deviceResults = document.getElementById('device-results');
const unusedBox = document.getElementById('unused-box');

const MIN_DEVICES = 2;
const MAX_DEVICES = 3;

const EXAMPLE_GEARS = [
  { id: 'G1', teeth: 10 },
  { id: 'G2', teeth: 12 },
  { id: 'G3', teeth: 15 },
  { id: 'G4', teeth: 20 },
  { id: 'G5', teeth: 30 },
  { id: 'G6', teeth: 40 },
  { id: 'G7', teeth: 50 },
  { id: 'G8', teeth: 60 },
  { id: 'G9', teeth: 80 },
  { id: 'G10', teeth: 100 },
  { id: 'G11', teeth: 24 },
  { id: 'G12', teeth: 25 },
];

const EXAMPLE_DEVICES = [
  { target: '1/12', tolerance: '5%' },
  { target: '1/6', tolerance: '5%' },
  { target: '1/5', tolerance: '5%' },
];

/* ---------------- 装置行 ---------------- */

function addDeviceRow(target = '', tolerance = '') {
  const idx = deviceBox.children.length;
  const row = document.createElement('div');
  row.className = 'device-row';
  row.innerHTML = `
    <div class="device-head">
      <span class="device-name">装置 ${idx + 1}</span>
      <button type="button" class="btn danger-ghost device-del" title="删除该装置">✕</button>
    </div>
    <div class="grid two device-fields">
      <label class="field">
        <span>目标输出转速比（输出 / 输入）</span>
        <input class="dev-target" value="${target}" placeholder="如 0.0833 或 1/12" />
      </label>
      <label class="field">
        <span>允许相对误差</span>
        <input class="dev-tolerance" value="${tolerance}" placeholder="如 5% 或 0.05" />
      </label>
    </div>`;
  row.querySelector('.device-del').addEventListener('click', () => {
    if (deviceBox.children.length <= MIN_DEVICES) {
      alert(`批量装配至少需要 ${MIN_DEVICES} 台装置`);
      return;
    }
    row.remove();
    renumberDevices();
  });
  deviceBox.appendChild(row);
}

function renumberDevices() {
  [...deviceBox.children].forEach((r, i) => {
    r.querySelector('.device-name').textContent = `装置 ${i + 1}`;
  });
}

document.getElementById('btn-device-add').addEventListener('click', () => {
  if (deviceBox.children.length >= MAX_DEVICES) {
    alert(`批量装配最多 ${MAX_DEVICES} 台装置`);
    return;
  }
  addDeviceRow();
});

/* ---------------- 齿轮行 ---------------- */

function addGearRow(id = '', teeth = '') {
  const row = document.createElement('div');
  row.className = 'gear-row';
  row.innerHTML = `
    <input class="gear-id-input" placeholder="如 G1" value="${id}" />
    <input class="gear-teeth-input" type="number" min="1" max="100000" step="1" placeholder="齿数" value="${teeth}" />
    <button type="button" class="btn danger-ghost" title="删除该齿轮">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => {
    if (rowsBox.children.length <= 2) {
      alert('至少保留 2 枚齿轮');
      return;
    }
    row.remove();
  });
  rowsBox.appendChild(row);
}

document.getElementById('btn-add').addEventListener('click', () => addGearRow());
document.getElementById('btn-example').addEventListener('click', () => {
  deviceBox.innerHTML = '';
  EXAMPLE_DEVICES.forEach((d) => addDeviceRow(d.target, d.tolerance));
  rowsBox.innerHTML = '';
  EXAMPLE_GEARS.forEach((g) => addGearRow(g.id, g.teeth));
});

/* 初始 2 台装置、2 枚齿轮 */
addDeviceRow('1/12', '5%');
addDeviceRow('1/6', '5%');
addGearRow('G1', 10);
addGearRow('G8', 60);

/* ---------------- 收集输入 ---------------- */

function collectDevices() {
  const devices = [];
  for (const row of deviceBox.querySelectorAll('.device-row')) {
    const target = row.querySelector('.dev-target').value.trim();
    const tolerance = row.querySelector('.dev-tolerance').value.trim();
    if (!target) throw new Error(`第 ${devices.length + 1} 台装置未填写目标输出转速比`);
    if (!tolerance) throw new Error(`第 ${devices.length + 1} 台装置未填写允许相对误差`);
    devices.push({ target, tolerance });
  }
  if (devices.length < MIN_DEVICES || devices.length > MAX_DEVICES) {
    throw new Error(`装置数量需在 ${MIN_DEVICES}～${MAX_DEVICES} 台之间`);
  }
  return devices;
}

function collectGears() {
  const gears = [];
  const ids = new Set();
  for (const row of rowsBox.querySelectorAll('.gear-row')) {
    const id = row.querySelector('.gear-id-input').value.trim();
    const teethRaw = row.querySelector('.gear-teeth-input').value.trim();
    if (!id && !teethRaw) continue; // 空行忽略
    if (!id) throw new Error('存在未填写编号的齿轮行');
    if (ids.has(id)) throw new Error(`齿轮编号重复：${id}`);
    ids.add(id);
    const teeth = Number(teethRaw);
    if (!Number.isInteger(teeth) || teeth < 1) throw new Error(`齿轮 ${id} 的齿数需为正整数`);
    gears.push({ id, teeth });
  }
  if (gears.length < 2) throw new Error('请至少填写 2 枚齿轮（最多 12 枚）');
  if (gears.length > 12) throw new Error('齿轮数量不能超过 12 枚');
  return gears;
}

/* ---------------- 渲染 ---------------- */

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function renderPairsTable(sel) {
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>级</th><th>主动轮（编号 / 齿数）</th><th>从动轮（编号 / 齿数）</th><th>本级速比（主动/从动）</th>
    </tr></thead>`;
  const tbody = el('tbody');
  sel.pairs.forEach((p, i) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="gear-id">${p.drive.id}</span> · ${p.drive.teeth} 齿</td>
      <td><span class="gear-id">${p.driven.id}</span> · ${p.driven.teeth} 齿</td>
      <td class="frac">${p.stageRatio.num}/${p.stageRatio.den} ≈ ${p.stageRatio.decimal}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderDeviceCard(d) {
  const card = el('div', `solution ${d.satisfied ? 'best' : 'unsatisfied'}`);

  const head = el('div', 'solution-head');
  const statusBadge = d.satisfied
    ? '<span class="badge">已满足</span>'
    : '<span class="badge badge-warn">未满足</span>';
  head.appendChild(el('span', 'solution-title',
    `${statusBadge}${d.name} · 目标比 ${d.target.num}/${d.target.den} ≈ ${d.target.decimal}` +
    ` · 容差 ${d.tolerance.decimal}`));
  card.appendChild(head);

  const meta = el('div', 'solution-meta');
  meta.innerHTML = `枚举达标配对 <strong>${d.totalMatches}</strong> 条，` +
    `按占用齿轮集合保留最优候选 <strong>${d.candidateCount}</strong> 个`;
  card.appendChild(meta);

  if (d.satisfied) {
    const s = d.selection;
    card.appendChild(el('p', 'device-pick-meta',
      `${s.stages} 级传动 · 实际转速比 <strong class="frac">${s.ratio.num}/${s.ratio.den}</strong>` +
      ` ≈ <strong>${s.ratio.decimal}</strong> · 相对误差 <strong>${s.errorPercent}%</strong>`));
    card.appendChild(renderPairsTable(s));
  } else {
    const why = d.totalMatches === 0
      ? '该装置在 1～3 级传动内本就不存在达标配对：可放宽容差或增加齿轮。'
      : '存在达标配对，但所需齿轮已优先分配给其他装置（为保证达标台数最多）：' +
        '可放宽容差、增加齿轮或调整装置顺序后重试。';
    card.appendChild(el('p', 'alert warn device-fail', why));
  }
  return card;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  resultPanel.hidden = true;

  let payload;
  try {
    payload = { devices: collectDevices(), gears: collectGears() };
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
    return;
  }

  try {
    const resp = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '批量装配失败');

    resultPanel.hidden = false;
    deviceResults.innerHTML = '';
    unusedBox.innerHTML = '';

    resultSummary.textContent =
      `达标 ${data.satisfiedCount}/${data.deviceCount} 台 · 总级数 ${data.totalStages}` +
      (data.errorSum ? ` · 相对误差之和 ${data.errorSumPercent}%` : '');

    optNote.textContent =
      '候选基于各台全部达标配对枚举（未使用单台接口的 300 条截断），' +
      '全局按「达标台数最多 → 总级数最少 → 相对误差之和最小 → 装置输入顺序 / 齿轮编号自然序」决胜。';

    data.devices.forEach((d) => deviceResults.appendChild(renderDeviceCard(d)));

    const unused = el('div', 'unused-inner');
    if (data.unusedGears.length === 0) {
      unused.innerHTML = '<strong>未用齿轮：</strong>无（齿轮已全部分配）';
    } else {
      unused.innerHTML = '<strong>未用齿轮：</strong>' +
        data.unusedGears.map((g) =>
          `<span class="gear-chip"><span class="gear-id">${g.id}</span> · ${g.teeth} 齿</span>`).join('');
    }
    unusedBox.appendChild(unused);
  } catch (e) {
    resultPanel.hidden = false;
    deviceResults.innerHTML = '';
    unusedBox.innerHTML = '';
    resultSummary.textContent = '';
    optNote.textContent = '';
    const box = el('p', 'alert error', `请求出错：${e.message}`);
    deviceResults.appendChild(box);
  }
});
