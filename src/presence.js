'use strict';

/**
 * 出场时段到位核对引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 页面逐行填写「道具、演员、起止分钟」，一次提交多行核对：
 * 演员应在 [start, end)（左闭右开：含起始分钟、不含结束分钟）全程持有该道具。
 *
 * 判定口径（沿用核验的同分钟唯一交接链规则）：
 * - 在起点分钟、以及区间内每一个有交接记录的分钟，把该分钟全部交接归约完成后
 *   取持有人与演员比对；终点分钟的交接不计入（区间右开）；
 * - 按时间顺序取首个不符或链冲突：
 *   · 不符（MISMATCH）：返回该分钟、实际持有人，以及导致该持有状态的交接记录
 *     （链上最后一条已执行记录；尚无任何交接时为 null，表示道具一直在仓库）；
 *   · 链冲突（UNKNOWN）：返回无法判定与冲突分钟——冲突之后分钟的记录不作为确定持有；
 * - 整个区间各判定分钟均匹配 → 到位（PRESENT）；
 *   区间结束分钟及以后的交接与冲突不影响本次结果。
 */

const { WAREHOUSE, CONFLICT, sortRecords, replayPropRecords } = require('./verify');

/** 核对结论 */
const ROW = {
  PRESENT: 'PRESENT',           // 到位：整个区间均匹配
  MISMATCH: 'MISMATCH',         // 不符：首个不符分钟的实际持有人与演员不一致
  UNKNOWN: 'UNKNOWN',           // 无法判定：判定所需分钟内交接链冲突
  UNREGISTERED: 'UNREGISTERED', // 道具名称未在道具清单登记
};

function conflictTypeText(type) {
  return type === CONFLICT.AMBIGUOUS ? '多条可接续（交接链不唯一）' : '剩余记录无法接续（断链）';
}

/**
 * 核对单行：演员 person 应在 [start, end) 全程持有该道具。
 * @param {Array} propRecords 该道具的全部交接记录（未按分钟筛选）
 * @param {string} person 演员（精确匹配）
 * @param {number} start 起始分钟（含）
 * @param {number} end 结束分钟（不含，须 > start）
 * @returns {{status: string, minute?: number, actualHolder?: string, record?: object|null,
 *            conflictMinute?: number, conflictType?: string, conflictRecords?: Array, reason?: string}}
 */
function checkRowInterval(propRecords, person, start, end) {
  const sorted = sortRecords(propRecords);

  // 判定分钟：起点 + 区间内（不含终点）每个有交接记录的分钟，按时间升序逐一核对，取首个问题
  const innerMinutes = [...new Set(
    sorted
      .map((r) => Number(r.minute))
      .filter((m) => m > start && m < end)
  )].sort((a, b) => a - b);
  const checkpoints = [start, ...innerMinutes];

  for (const m of checkpoints) {
    // 只重放该分钟及以前的记录：该分钟全部交接完成后取持有人；
    // 更晚分钟的记录（含更晚的冲突）不参与判定
    const replay = replayPropRecords(sorted.filter((r) => Number(r.minute) <= m));

    if (!replay.ok) {
      // 链冲突：无法判定；冲突之后的记录不作为确定持有
      return {
        status: ROW.UNKNOWN,
        conflictMinute: replay.conflict.minute,
        conflictType: replay.conflict.type,
        conflictRecords: replay.conflict.records || [],
        reason: replay.conflict.reason,
      };
    }

    if (replay.holder !== person) {
      // 不符：导致该持有状态的是链上最后一条已执行的交接记录（无记录则道具一直在仓库）
      const cause = replay.chain.length > 0 ? replay.chain[replay.chain.length - 1] : null;
      return {
        status: ROW.MISMATCH,
        minute: m,
        actualHolder: replay.holder,
        record: cause
          ? { id: cause.id, minute: cause.minute, from: cause.from, to: cause.to, note: cause.note || '' }
          : null,
      };
    }
  }

  return { status: ROW.PRESENT };
}

function rowNote(input, result) {
  const span = `第${input.start}–${input.end}分钟（含第${input.start}分、不含第${input.end}分）`;
  switch (result.status) {
    case ROW.PRESENT:
      return `${span}各判定分钟持有人均为「${input.person}」，整段到位`;
    case ROW.MISMATCH: {
      const cause = result.record
        ? `第${result.record.minute}分钟 ${result.record.from} → ${result.record.to} 后由「${result.actualHolder}」持有`
        : `此前无任何交接记录，道具一直在「${WAREHOUSE}」`;
      return `第${result.minute}分钟（该分钟全部交接完成后）起应由「${input.person}」持有，` +
        `实际持有人为「${result.actualHolder}」：${cause}`;
    }
    case ROW.UNKNOWN:
      return `第${result.conflictMinute}分钟交接链冲突（${conflictTypeText(result.conflictType)}），` +
        '该时段持有人无法判定；冲突后的记录不作为确定持有';
    default:
      return '';
  }
}

/**
 * 执行一次出场时段到位核对（多行）。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {Array<{prop: string, person: string, start: number, end: number}>} inputRows 核对行
 * @returns {{warehouse: string, rows: Array, summary: object}}
 */
function checkPresence(data, inputRows) {
  const props = data.props || [];
  const records = data.records || [];
  const propByName = new Map(props.map((p) => [p.name, p]));

  const rows = inputRows.map((input, idx) => {
    const base = {
      rowNo: idx + 1,
      prop: input.prop,
      person: input.person,
      start: input.start,
      end: input.end,
      propId: null,
    };

    const prop = propByName.get(input.prop);
    if (!prop) {
      return { ...base, status: ROW.UNREGISTERED, note: `道具「${input.prop}」未在道具清单登记` };
    }

    const result = checkRowInterval(
      records.filter((r) => r.propId === prop.id),
      input.person,
      input.start,
      input.end
    );

    return { ...base, propId: prop.id, ...result, note: rowNote(input, result) };
  });

  const summary = {
    total: rows.length,
    present: rows.filter((r) => r.status === ROW.PRESENT).length,
    mismatch: rows.filter((r) => r.status === ROW.MISMATCH).length,
    unknown: rows.filter((r) => r.status === ROW.UNKNOWN).length,
    unregistered: rows.filter((r) => r.status === ROW.UNREGISTERED).length,
  };
  summary.allPresent = summary.total > 0 && summary.present === summary.total;

  return { warehouse: WAREHOUSE, rows, summary };
}

module.exports = { ROW, checkRowInterval, checkPresence };
