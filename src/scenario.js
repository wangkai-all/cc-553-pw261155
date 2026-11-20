import { readFile } from 'node:fs/promises';

import { ValidationError } from './errors.js';
import { assertRange, sameSpan, spanContains } from './intervals.js';

export const OUTCOMES = Object.freeze(['error', 'approved', 'partial', 'rejected']);
export const ATTEMPT_STATUSES = Object.freeze(['active', 'closed', 'revoked', 'superseded']);

function fail(message) {
  throw new ValidationError(message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} 必须是非空字符串`);
  }
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail(`${field} 必须是数组`);
  return value;
}

function requireTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${field} 必须是可解析的时间戳，例如 2026-02-18T08:00:00Z，收到：${JSON.stringify(value)}`);
  }
  return value;
}

function requireUniqueId(item, seen, field) {
  requireNonEmptyString(item?.id, `${field}.id`);
  if (seen.has(item.id)) fail(`${field}.id 重复：${item.id}`);
  seen.add(item.id);
}

function normalizeSpan(value, field, { optional = false } = {}) {
  if (value == null) {
    if (optional) return null;
    fail(`${field} 不能为空`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} 必须是 { start, end } 对象`);
  }
  assertRange(value.start, value.end, field);
  return { start: value.start, end: value.end };
}

function normalizeAttempt(raw, report, index, attemptSeen, globalAttemptIds) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`report ${report.id} 的第 ${index + 1} 条审批必须是对象`);
  }
  requireUniqueId(raw, globalAttemptIds, `report ${report.id} 的审批`);
  if (!OUTCOMES.includes(raw.outcome)) {
    fail(`审批 ${raw.id} 的 outcome 必须是 ${OUTCOMES.join(' / ')}，收到：${JSON.stringify(raw.outcome)}`);
  }
  if (!Number.isInteger(raw.attempt) || raw.attempt < 1) {
    fail(`审批 ${raw.id} 的 attempt 必须是正整数`);
  }
  if (attemptSeen.has(raw.attempt)) {
    fail(`report ${report.id} 的审批序号 ${raw.attempt} 重复`);
  }
  attemptSeen.add(raw.attempt);

  const decidedAt = requireTimestamp(raw.decidedAt, `审批 ${raw.id} 的 decidedAt`);
  const defaultStatus = raw.outcome === 'approved' || raw.outcome === 'partial' ? 'active' : 'closed';
  const status = raw.status ?? defaultStatus;
  if (!ATTEMPT_STATUSES.includes(status)) {
    fail(`审批 ${raw.id} 的 status 必须是 ${ATTEMPT_STATUSES.join(' / ')}，收到：${JSON.stringify(status)}`);
  }

  let approvedSpan = null;
  if (raw.outcome === 'approved' || raw.outcome === 'partial') {
    approvedSpan = normalizeSpan(raw.approvedSpan, `审批 ${raw.id} 的批准区间`);
    if (!spanContains(report.originalSpan, approvedSpan)) {
      fail(
        `审批 ${raw.id} 的批准区间 ${approvedSpan.start} ~ ${approvedSpan.end} `
          + `超出原申报区间 ${report.originalSpan.start} ~ ${report.originalSpan.end}`,
      );
    }
    if (raw.outcome === 'partial' && sameSpan(approvedSpan, report.originalSpan)) {
      fail(`审批 ${raw.id} 标记为部分批准，但批准区间与原申报区间完全相同`);
    }
  } else if (raw.approvedSpan != null) {
    fail(`审批 ${raw.id} 的 outcome 为 ${raw.outcome}，不能携带批准区间`);
  }

  return {
    id: raw.id,
    attempt: raw.attempt,
    outcome: raw.outcome,
    approvedSpan,
    decidedAt,
    status,
    message: typeof raw.message === 'string' ? raw.message : '',
  };
}

export function normalizeScenario(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('场景数据必须是 JSON 对象');
  }

  const teamIds = new Set();
  const teams = requireArray(raw.teams, 'teams').map((team, index) => {
    if (team == null || typeof team !== 'object') fail(`teams[${index}] 必须是对象`);
    requireUniqueId(team, teamIds, `teams[${index}]`);
    return { id: team.id, name: requireNonEmptyString(team.name, `team ${team.id} 的 name`) };
  });
  if (teams.length === 0) fail('teams 至少需要一个班组');

  const roadIds = new Set();
  const roadCodes = new Set();
  const roads = requireArray(raw.roads, 'roads').map((road, index) => {
    if (road == null || typeof road !== 'object') fail(`roads[${index}] 必须是对象`);
    requireUniqueId(road, roadIds, `roads[${index}]`);
    const code = requireNonEmptyString(road.code, `road ${road.id} 的 code`);
    if (roadCodes.has(code)) fail(`道路编号重复：${code}`);
    roadCodes.add(code);
    return { id: road.id, code, name: requireNonEmptyString(road.name, `road ${road.id} 的 name`) };
  });
  if (roads.length === 0) fail('roads 至少需要一条道路');

  const reportIds = new Set();
  const attemptIds = new Set();
  const reports = requireArray(raw.reports, 'reports').map((report, index) => {
    if (report == null || typeof report !== 'object') fail(`reports[${index}] 必须是对象`);
    requireUniqueId(report, reportIds, `reports[${index}]`);
    if (!roadIds.has(report.roadId)) fail(`report ${report.id} 引用了不存在的道路 ${report.roadId}`);
    if (!teamIds.has(report.teamId)) fail(`report ${report.id} 引用了不存在的班组 ${report.teamId}`);

    const originalSpan = normalizeSpan(report.originalSpan, `report ${report.id} 的原申报区间`);
    const submittedAt = requireTimestamp(report.submittedAt, `report ${report.id} 的 submittedAt`);
    const attempts = requireArray(report.approvalAttempts ?? [], `report ${report.id} 的 approvalAttempts`);
    const attemptSeen = new Set();
    const approvalAttempts = attempts
      .map((attempt, attemptIndex) => normalizeAttempt(attempt, { id: report.id, originalSpan }, attemptIndex, attemptSeen, attemptIds))
      .sort((left, right) => left.attempt - right.attempt);

    return {
      id: report.id,
      roadId: report.roadId,
      teamId: report.teamId,
      work: requireNonEmptyString(report.work, `report ${report.id} 的 work`),
      originalSpan,
      submittedAt,
      approvalAttempts,
    };
  });
  if (reports.length === 0) fail('reports 至少需要一条申报');

  return {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : '未命名施工申报场景',
    description: typeof raw.description === 'string' ? raw.description : '',
    teams,
    roads,
    reports,
  };
}

export async function loadScenarioFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取场景文件 ${filePath}：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`场景文件 ${filePath} 不是合法 JSON：${error.message}`);
  }
  return normalizeScenario(parsed);
}
