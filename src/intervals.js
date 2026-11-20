import { ValidationError } from './errors.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function assertISODate(value, field = '日期') {
  if (!isISODate(value)) {
    throw new ValidationError(
      `${field} 必须是 YYYY-MM-DD 格式的有效日期，收到：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertRange(start, end, label = '区间') {
  assertISODate(start, `${label}开始日期`);
  assertISODate(end, `${label}结束日期`);
  if (start >= end) {
    throw new ValidationError(`${label}必须满足开始日期早于结束日期（半开区间），收到：${start} ~ ${end}`);
  }
}

/**
 * 半开区间 [start, end) 的重叠判定。
 * 关键规则：一段结束于某日、另一段从同一天开始时，两段只是“同日相接”，
 * 不构成重叠，必须分别保留。
 */
export function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

export function isAdjacent(left, right) {
  return left.start === right.end || right.start === left.end;
}

export function spanContains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function sameSpan(left, right) {
  return left.start === right.start && left.end === right.end;
}

export function dayCount(span) {
  const start = Date.parse(`${span.start}T00:00:00Z`);
  const end = Date.parse(`${span.end}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * 从 base 中减去全部 blockers，返回仍可用的连续片段。
 * 仅使用现有端点做切割，不依赖日期加减；端点相接不产生残余。
 */
export function subtractIntervals(base, blockers = []) {
  const ordered = blockers
    .filter((item) => overlaps(base, item))
    .map((item) => ({ start: item.start, end: item.end }))
    .sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start.localeCompare(b.start)));

  const fragments = [];
  let cursor = base.start;
  for (const blocker of ordered) {
    if (blocker.end <= cursor) continue;
    if (blocker.start >= base.end) break;
    if (blocker.start > cursor) {
      fragments.push({ start: cursor, end: blocker.start });
    }
    if (blocker.end > cursor) cursor = blocker.end;
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) fragments.push({ start: cursor, end: base.end });
  return fragments;
}

export function mergeSpans(spans) {
  const sorted = [...spans]
    .filter((span) => span.start < span.end)
    .sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start.localeCompare(b.start)));
  const merged = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function fullyCovered(span, covers) {
  return subtractIntervals(span, covers).length === 0;
}
