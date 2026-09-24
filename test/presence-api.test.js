'use strict';

/* 出场时段到位核对接口集成测试：node test/presence-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-presence-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function post(rows) {
  return api('/api/presence/check', { method: 'POST', body: JSON.stringify({ rows }) });
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：
  // 青龙剑 p_sword：仓库→张三@0 →李四@3 →张三@8 →仓库@12（完整归仓链）
  // 折扇 p_fan：仓库→张三@1，第5分 张三→王五 / 张三→赵六 多条可接续冲突
  // 宫灯 p_lantern：仓库→王五@2，第4分 李四→钱七 断链冲突，钱七→仓库@9
  // 御印 p_seal：仓库→周八@1 →孙七@6（演出结束未归仓）
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 一次核对多行：到位 / 不符 / 无法判定 / 未登记 齐备，逐行结论与汇总正确
  await test('到位核对：一次核对多行，逐行结论与汇总正确', async () => {
    const res = await post([
      { prop: '青龙剑', person: '张三', start: 0, end: 3 },   // 到位
      { prop: '青龙剑', person: '张三', start: 0, end: 5 },   // 第3分不符（李四）
      { prop: '青龙剑', person: '张三', start: 8, end: 12 },  // 到位（终点12的归仓交接不计入）
      { prop: '折扇', person: '张三', start: 1, end: 5 },     // 到位（终点5的冲突交接不计入）
      { prop: '折扇', person: '张三', start: 1, end: 6 },     // 第5分冲突 -> 无法判定
      { prop: '宫灯', person: '王五', start: 2, end: 4 },     // 到位
      { prop: '宫灯', person: '王五', start: 2, end: 5 },     // 第4分断链 -> 无法判定
      { prop: '不存在', person: '张三', start: 0, end: 1 },   // 未登记
    ]);
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.warehouse, '仓库');
    assert.strictEqual(r.rows.length, 8);
    assert.deepStrictEqual(r.rows.map((x) => x.status), [
      'PRESENT', 'MISMATCH', 'PRESENT', 'PRESENT', 'UNKNOWN', 'PRESENT', 'UNKNOWN', 'UNREGISTERED',
    ]);
    // 不符行：分钟、实际持有人、导致该状态的交接记录
    const mm = r.rows[1];
    assert.strictEqual(mm.minute, 3);
    assert.strictEqual(mm.actualHolder, '李四');
    assert.strictEqual(mm.record.id, 'r_sw2');
    assert.strictEqual(mm.record.minute, 3);
    assert.strictEqual(mm.record.from, '张三');
    assert.strictEqual(mm.record.to, '李四');
    // 冲突行：无法判定 + 冲突分钟与类型
    assert.strictEqual(r.rows[4].conflictMinute, 5);
    assert.strictEqual(r.rows[4].conflictType, 'AMBIGUOUS');
    assert.strictEqual(r.rows[6].conflictMinute, 4);
    assert.strictEqual(r.rows[6].conflictType, 'BROKEN');
    // 汇总
    assert.strictEqual(r.summary.total, 8);
    assert.strictEqual(r.summary.present, 4);
    assert.strictEqual(r.summary.mismatch, 1);
    assert.strictEqual(r.summary.unknown, 2);
    assert.strictEqual(r.summary.unregistered, 1);
    assert.strictEqual(r.summary.allPresent, false);
  });

  // 2. 只读：核对不改写数据（版本号与记录数不变）
  await test('到位核对：接口只读，数据版本与记录数不变', async () => {
    await post([{ prop: '青龙剑', person: '张三', start: 0, end: 12 }]);
    await post([{ prop: '折扇', person: '张三', start: 1, end: 6 }]);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 3. 参数校验：非数组 / 空数组 / 缺字段 / 起止颠倒或相等 / 非法分钟均 400
  await test('到位核对：参数校验（空行、缺字段、起止颠倒、非法分钟）', async () => {
    let res = await api('/api/presence/check', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(res.status, 400);
    res = await post([]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '', person: '张三', start: 0, end: 1 }]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '青龙剑', person: '', start: 0, end: 1 }]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '青龙剑', person: '张三', start: 5, end: 3 }]);
    assert.strictEqual(res.status, 400);
    assert.ok(/起始分钟必须小于结束分钟/.test(res.body.error));
    res = await post([{ prop: '青龙剑', person: '张三', start: 5, end: 5 }]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '青龙剑', person: '张三', start: -1, end: 3 }]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '青龙剑', person: '张三', start: 0.5, end: 3 }]);
    assert.strictEqual(res.status, 400);
    res = await post([{ prop: '青龙剑', person: '张三', start: 0 }]);
    assert.strictEqual(res.status, 400);
  });

  // 4. 全部行匹配时 allPresent 为 true（未归仓道具不影响到位判定）
  await test('到位核对：全部行匹配时 allPresent 为 true', async () => {
    const res = await post([
      { prop: '青龙剑', person: '李四', start: 3, end: 8 },
      { prop: '御印', person: '孙七', start: 6, end: 10 },
    ]);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.present, 2);
    assert.strictEqual(res.body.summary.allPresent, true);
  });

  // 5. 区间结束后的冲突不影响结果；冲突后的记录不作为确定持有
  await test('到位核对：区间后冲突不影响；冲突后记录不作数', async () => {
    // 折扇冲突在第5分：[1,5) 终点不计入 -> 到位；[1,6) 覆盖冲突 -> 无法判定
    const res = await post([
      { prop: '折扇', person: '张三', start: 1, end: 5 },
      { prop: '折扇', person: '张三', start: 1, end: 6 },
    ]);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.rows.map((x) => x.status), ['PRESENT', 'UNKNOWN']);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个到位核对接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
