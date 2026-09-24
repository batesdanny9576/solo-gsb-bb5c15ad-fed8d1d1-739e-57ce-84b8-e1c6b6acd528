'use strict';

/* 出场时段到位核对引擎单元测试：node test/presence.test.js */

const assert = require('assert');
const { checkPresence, ROW } = require('../src/presence');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n; // 录入先后用递增 createdAt 表示

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}
function row(prop, person, start, end) {
  return { prop, person, start, end };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 整个区间均匹配 -> 到位
test('到位核对：整个区间均匹配 -> 到位', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', WAREHOUSE),
  ]);
  const r = checkPresence(data, [row('剑', '李四', 3, 8)]);
  assert.strictEqual(r.rows[0].status, ROW.PRESENT);
  assert.strictEqual(r.rows[0].propId, 'p0');
  assert.strictEqual(r.summary.present, 1);
  assert.strictEqual(r.summary.allPresent, true);
  // 张三 [0,3)：起点第0分交接完成后张三持有，区间内无交接分钟
  const r2 = checkPresence(data, [row('剑', '张三', 0, 3)]);
  assert.strictEqual(r2.rows[0].status, ROW.PRESENT);
});

// 2. 起点分钟的交接计入：起点分钟全部交接完成后判定（含同分钟链式）
test('到位核对：起点分钟全部交接完成后判定（含同分钟链式）', () => {
  const data = mkData(['枪'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '李四'),
    rec('p0', 5, '李四', '王五'),
  ]);
  // 王五 [5,9)：第5分 张三→李四→王五 链式交接全部完成后由王五持有
  const r = checkPresence(data, [row('枪', '王五', 5, 9)]);
  assert.strictEqual(r.rows[0].status, ROW.PRESENT);
  // 李四 [5,9)：第5分全部交接完成后持有人是王五而非李四 -> 第5分不符
  const r2 = checkPresence(data, [row('枪', '李四', 5, 9)]);
  assert.strictEqual(r2.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(r2.rows[0].minute, 5);
  assert.strictEqual(r2.rows[0].actualHolder, '王五');
  assert.strictEqual(r2.rows[0].record.to, '王五');
});

// 3. 终点分钟的交接不计入
test('到位核对：终点分钟的交接不计入', () => {
  const data = mkData(['扇'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 9, '张三', WAREHOUSE),
  ]);
  // 张三 [2,9)：第9分归仓交接不计入 -> 到位
  const r = checkPresence(data, [row('扇', '张三', 2, 9)]);
  assert.strictEqual(r.rows[0].status, ROW.PRESENT);
  // 张三 [2,10)：第9分成为区间内交接分钟 -> 第9分不符，实际持有人为仓库
  const r2 = checkPresence(data, [row('扇', '张三', 2, 10)]);
  assert.strictEqual(r2.rows[0].status, ROW.MISMATCH);
  assert.strictEqual(r2.rows[0].minute, 9);
  assert.strictEqual(r2.rows[0].actualHolder, WAREHOUSE);
  assert.strictEqual(r2.rows[0].record.minute, 9);
});

// 4. 按时间顺序取首个不符：返回分钟、实际持有人与导致记录
test('到位核对：按时间顺序取首个不符，返回分钟/实际持有人/导致记录', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 6, '李四', '王五'),
  ]);
  const r = checkPresence(data, [row('剑', '张三', 0, 9)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.MISMATCH);
  assert.strictEqual(row0.minute, 3); // 首个不符分钟（第6分的再次交接不再判定）
  assert.strictEqual(row0.actualHolder, '李四');
  assert.strictEqual(row0.record.minute, 3);
  assert.strictEqual(row0.record.from, '张三');
  assert.strictEqual(row0.record.to, '李四');
});

// 5. 起点即不符：导致记录可早于区间
test('到位核对：起点即不符，导致记录可早于区间', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'),
  ]);
  const r = checkPresence(data, [row('剑', '张三', 5, 9)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.MISMATCH);
  assert.strictEqual(row0.minute, 5); // 不符分钟为起始分钟
  assert.strictEqual(row0.actualHolder, '李四');
  assert.strictEqual(row0.record.minute, 2); // 导致该状态的是区间前的交接
});

// 6. 无交接记录：实际持有人为仓库，导致记录为 null
test('到位核对：无交接记录 -> 不符，实际持有人为仓库且无导致记录', () => {
  const data = mkData(['空箱'], []);
  const r = checkPresence(data, [row('空箱', '张三', 1, 4)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.MISMATCH);
  assert.strictEqual(row0.minute, 1);
  assert.strictEqual(row0.actualHolder, WAREHOUSE);
  assert.strictEqual(row0.record, null);
});

// 7. 仓库作为演员：无记录道具全程在仓库 -> 到位
test('到位核对：仓库作为演员，无记录道具全程到位', () => {
  const data = mkData(['空箱'], []);
  const r = checkPresence(data, [row('空箱', WAREHOUSE, 0, 5)]);
  assert.strictEqual(r.rows[0].status, ROW.PRESENT);
});

// 8. 区间前链冲突 -> 无法判定，给出冲突分钟
test('到位核对：区间前链冲突 -> 无法判定并给出冲突分钟', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = checkPresence(data, [row('扇', '张三', 8, 12)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.UNKNOWN);
  assert.strictEqual(row0.conflictMinute, 5);
  assert.strictEqual(row0.conflictType, 'AMBIGUOUS');
  assert.strictEqual(row0.conflictRecords.length, 2);
});

// 9. 区间内链冲突 -> 无法判定
test('到位核对：区间内链冲突 -> 无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = checkPresence(data, [row('扇', '张三', 1, 9)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.UNKNOWN);
  assert.strictEqual(row0.conflictMinute, 5);
});

// 10. 冲突后的记录不作为确定持有
test('到位核对：冲突后的记录不作为确定持有', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
    rec('p0', 6, '王五', '张三'), // 冲突之后的记录：即使指向张三也不作数
  ]);
  const r = checkPresence(data, [row('扇', '张三', 1, 9)]);
  assert.strictEqual(r.rows[0].status, ROW.UNKNOWN);
  assert.strictEqual(r.rows[0].conflictMinute, 5);
});

// 11. 区间结束分钟及以后的冲突不影响结果
test('到位核对：区间结束分钟及以后的冲突不影响结果', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  // 终点第5分的交接（含其冲突）不计入
  const r = checkPresence(data, [row('扇', '张三', 1, 5)]);
  assert.strictEqual(r.rows[0].status, ROW.PRESENT);
  // 冲突在区间结束之后
  const r2 = checkPresence(data, [row('扇', '张三', 1, 4)]);
  assert.strictEqual(r2.rows[0].status, ROW.PRESENT);
});

// 12. 断链冲突 -> 无法判定（BROKEN）
test('到位核对：断链冲突 -> 无法判定（BROKEN）', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
  ]);
  const r = checkPresence(data, [row('灯', '王五', 2, 9)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.UNKNOWN);
  assert.strictEqual(row0.conflictMinute, 4);
  assert.strictEqual(row0.conflictType, 'BROKEN');
});

// 13. 不符分钟早于冲突分钟时，按时间顺序返回首个不符
test('到位核对：不符分钟早于冲突分钟时返回首个不符', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'),
    rec('p0', 5, '李四', '王五'),
    rec('p0', 5, '李四', '赵六'),
  ]);
  const r = checkPresence(data, [row('剑', '张三', 0, 9)]);
  const row0 = r.rows[0];
  assert.strictEqual(row0.status, ROW.MISMATCH); // 第2分已不符，第5分冲突不再判定
  assert.strictEqual(row0.minute, 2);
  assert.strictEqual(row0.actualHolder, '李四');
});

// 14. 道具未登记 -> 单列，不参与判定
test('到位核对：道具未登记 -> 单列，不参与判定', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三')]);
  const r = checkPresence(data, [row('不存在', '张三', 0, 1)]);
  assert.strictEqual(r.rows[0].status, ROW.UNREGISTERED);
  assert.strictEqual(r.rows[0].propId, null);
  assert.strictEqual(r.summary.unregistered, 1);
});

// 15. 一次核对多行并汇总
test('到位核对：一次核对多行并汇总', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p1', 1, WAREHOUSE, '王五'),
  ]);
  const r = checkPresence(data, [
    row('剑', '张三', 0, 3),     // 到位
    row('剑', '张三', 0, 5),     // 第3分不符
    row('扇', '王五', 1, 6),     // 到位
    row('不存在', '张三', 0, 1), // 未登记
  ]);
  assert.deepStrictEqual(
    r.rows.map((x) => x.status),
    [ROW.PRESENT, ROW.MISMATCH, ROW.PRESENT, ROW.UNREGISTERED]
  );
  assert.deepStrictEqual(r.rows.map((x) => x.rowNo), [1, 2, 3, 4]);
  assert.strictEqual(r.summary.total, 4);
  assert.strictEqual(r.summary.present, 2);
  assert.strictEqual(r.summary.mismatch, 1);
  assert.strictEqual(r.summary.unknown, 0);
  assert.strictEqual(r.summary.unregistered, 1);
  assert.strictEqual(r.summary.allPresent, false);
  assert.strictEqual(r.warehouse, WAREHOUSE);
});

console.log(`\n全部 ${passed} 个到位核对测试通过 ✔`);
