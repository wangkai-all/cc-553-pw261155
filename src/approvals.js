import { ValidationError } from './errors.js';

export const PRIORITY_MODES = Object.freeze(['first-submitted', 'latest-approval']);

export function assertPriorityMode(mode) {
  if (!PRIORITY_MODES.includes(mode)) {
    throw new ValidationError(
      `未知裁决优先级：${JSON.stringify(mode)}，可选 ${PRIORITY_MODES.join(' / ')}`,
    );
  }
  return mode;
}

/**
 * 从审批链中挑出“当前有效”的那次审批。
 *
 * - outcome=error 是故障重试，不构成审批决定，直接跳过；
 * - status=superseded 表示被后续审批取代，跳过；
 * - 其余取序号最大的那次（已按 attempt 升序）；
 * - 最终是否可发布由 status/outcome 决定，revoked 不产生任何可公示片段。
 */
export function effectiveAttempt(report) {
  const attempts = [...report.approvalAttempts].sort((left, right) => left.attempt - right.attempt);
  const decided = attempts.filter(
    (attempt) => attempt.outcome !== 'error' && attempt.status !== 'superseded',
  );
  return decided.at(-1) ?? null;
}

export function resolveApproval(report, revocations = {}) {
  const attempts = [...report.approvalAttempts].sort((left, right) => left.attempt - right.attempt);
  const retries = attempts
    .filter((attempt) => attempt.outcome === 'error')
    .map((attempt) => ({
      id: attempt.id,
      attempt: attempt.attempt,
      decidedAt: attempt.decidedAt,
      message: attempt.message,
    }));

  const effective = effectiveAttempt(report);

  if (!effective) {
    return {
      reportId: report.id,
      effective: null,
      state: 'retryable-error',
      reason: retries.length > 0 ? '审批服务故障，等待重试' : '尚未产生审批决定',
      retries,
    };
  }

  const revocation = revocations[effective.id];
  const status = revocation ? 'revoked' : effective.status;
  const base = {
    reportId: report.id,
    effective: { ...effective, status },
    retries,
    revocation: revocation ?? null,
  };

  if (status === 'revoked') {
    return {
      ...base,
      state: 'revoked',
      reason: revocation?.reason || '审批已撤销',
    };
  }
  if (effective.outcome === 'rejected') {
    return { ...base, state: 'rejected', reason: '审批整段拒绝' };
  }
  if (status === 'closed') {
    return { ...base, state: 'closed', reason: '审批已关闭，不具备公示效力' };
  }
  if (effective.outcome === 'approved' || effective.outcome === 'partial') {
    return {
      ...base,
      state: effective.outcome === 'partial' ? 'partially-approved' : 'approved',
      approvedSpan: effective.approvedSpan,
      reason: effective.message || '',
    };
  }
  return { ...base, state: 'unknown', reason: `无法识别的审批结果：${effective.outcome}` };
}

/**
 * 把所有申报转换为待裁决的“审批有效主张”。原申报区间原样保留，
 * 只有审批覆盖的那一段才会成为可公示主张。
 */
export function collectClaims(scenario, revocations = {}) {
  const teamById = new Map(scenario.teams.map((team) => [team.id, team]));
  const roadById = new Map(scenario.roads.map((road) => [road.id, road]));
  const claims = [];
  const exclusions = [];
  const retryQueue = [];

  for (const report of scenario.reports) {
    const resolution = resolveApproval(report, revocations);
    const team = teamById.get(report.teamId);
    const road = roadById.get(report.roadId);
    const common = {
      reportId: report.id,
      roadId: report.roadId,
      roadCode: road.code,
      roadName: road.name,
      teamId: report.teamId,
      teamName: team.name,
      work: report.work,
      originalSpan: report.originalSpan,
      submittedAt: report.submittedAt,
    };

    if (resolution.state === 'approved' || resolution.state === 'partially-approved') {
      claims.push({
        ...common,
        approvalId: resolution.effective.id,
        attempt: resolution.effective.attempt,
        outcome: resolution.effective.outcome,
        decidedAt: resolution.effective.decidedAt,
        approvedSpan: resolution.approvedSpan,
        retries: resolution.retries,
      });
    } else {
      exclusions.push({
        ...common,
        approvalId: resolution.effective?.id ?? null,
        attempt: resolution.effective?.attempt ?? null,
        state: resolution.state,
        reason: resolution.reason,
        retries: resolution.retries,
      });
    }

    if (resolution.state === 'retryable-error') {
      retryQueue.push({
        reportId: report.id,
        roadId: report.roadId,
        teamId: report.teamId,
        retries: resolution.retries,
      });
    }
  }

  return { claims, exclusions, retryQueue };
}
