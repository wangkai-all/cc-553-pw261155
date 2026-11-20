import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dayCount,
  isAdjacent,
  isISODate,
  overlaps,
  subtractIntervals,
} from '../src/intervals.js';
import { ValidationError } from '../src/errors.js';

describe('半开区间 [start, end) 代数', () => {
  it('同日相接不算重叠', () => {
    const first = { start: '2026-03-01', end: '2026-03-10' };
    const second = { start: '2026-03-10', end: '2026-03-20' };
    assert.equal(overlaps(first, second), false);
    assert.equal(overlaps(second, first), false);
    assert.equal(isAdjacent(first, second), true);
  });

  it('共享一天即视为重叠', () => {
    assert.equal(
      overlaps({ start: '2026-03-01', end: '2026-03-10' }, { start: '2026-03-09', end: '2026-03-20' }),
      true,
    );
  });

  it('单日区间相接仍然互不重叠', () => {
    assert.equal(
      overlaps({ start: '2026-03-10', end: '2026-03-11' }, { start: '2026-03-11', end: '2026-03-12' }),
      false,
    );
  });

  it('相减时端点相接不产生零长度残余', () => {
    const remainder = subtractIntervals(
      { start: '2026-03-01', end: '2026-03-10' },
      [{ start: '2026-03-10', end: '2026-03-20' }],
    );
    assert.deepEqual(remainder, [{ start: '2026-03-01', end: '2026-03-10' }]);
  });

  it('完全覆盖时相减结果为空', () => {
    const remainder = subtractIntervals(
      { start: '2026-03-05', end: '2026-03-08' },
      [{ start: '2026-03-01', end: '2026-03-10' }],
    );
    assert.deepEqual(remainder, []);
  });

  it('多个遮挡区间可切出多段', () => {
    const remainder = subtractIntervals(
      { start: '2026-03-01', end: '2026-03-20' },
      [
        { start: '2026-03-12', end: '2026-03-14' },
        { start: '2026-03-05', end: '2026-03-07' },
      ],
    );
    assert.deepEqual(remainder, [
      { start: '2026-03-01', end: '2026-03-05' },
      { start: '2026-03-07', end: '2026-03-12' },
      { start: '2026-03-14', end: '2026-03-20' },
    ]);
  });

  it('可处理乱序与相邻遮挡', () => {
    const remainder = subtractIntervals(
      { start: '2026-03-01', end: '2026-03-20' },
      [
        { start: '2026-03-08', end: '2026-03-12' },
        { start: '2026-03-01', end: '2026-03-02' },
        { start: '2026-03-12', end: '2026-03-15' },
      ],
    );
    assert.deepEqual(remainder, [
      { start: '2026-03-02', end: '2026-03-08' },
      { start: '2026-03-15', end: '2026-03-20' },
    ]);
  });

  it('只按端点切割，不依赖日期加减', () => {
    const remainder = subtractIntervals(
      { start: '2026-02-27', end: '2026-03-03' },
      [{ start: '2026-02-28', end: '2026-03-01' }],
    );
    assert.deepEqual(remainder, [
      { start: '2026-02-27', end: '2026-02-28' },
      { start: '2026-03-01', end: '2026-03-03' },
    ]);
  });

  it('日期校验拒绝非法日期与倒置区间', () => {
    assert.equal(isISODate('2026-02-29'), false);
    assert.equal(isISODate('2024-02-29'), true);
    assert.equal(isISODate('2026-13-01'), false);
    assert.equal(isISODate('2026-3-1'), false);
  });

  it('天数按半开区间计算', () => {
    assert.equal(dayCount({ start: '2026-03-01', end: '2026-03-10' }), 9);
    assert.equal(dayCount({ start: '2026-02-28', end: '2026-03-01' }), 1);
  });

  it('非法区间在断言时抛 ValidationError', async () => {
    const { assertRange } = await import('../src/intervals.js');
    assert.throws(() => assertRange('2026-03-10', '2026-03-10'), ValidationError);
    assert.throws(() => assertRange('2026-03-11', '2026-03-10'), ValidationError);
  });
});
