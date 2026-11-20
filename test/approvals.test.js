import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveApproval, collectClaims } from '../src/approvals.js';
import { normalizeScenario } from '../src/scenario.js';

function baseScenario(overrides = {}) {
  return normalizeScenario({
    title: '测试场景',
    teams: [{ id: 'T1', name: '一班' }, { id: 'T2', name: '二班' }],
    roads: [{ id: 'R1', code: 'R-1', name: '测试路' }],
    reports: [
      {
        id: 'RPT-1',
        roadId: 'R1',
        teamId: 'T1',
        work: '测试施工',
        originalSpan: { start: '2026-03-01', end: '2026-03-20' },
        submittedAt: '2026-02-01T00:00:00Z',
        approvalAttempts: [
          {
            id: 'APR-X1',
            attempt: 1,
            outcome: 'error',
            decidedAt: '2026-02-02T00:00:00Z',
            status: 'closed',
            message: '网关超时',
          },
          {
            id: 'APR-X2',
            attempt: 2,
            outcome: 'approved',
            approvedSpan: { start: '2026-03-01', end: '2026-03-20' },
            decidedAt: '2026-02-03T00:00:00Z',
            status: 'active',
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe('审批解析', () => {
  it('故障重试不构成审批决定，取后续成功的那次', () => {
    const scenario = baseScenario();
    const resolution = resolveApproval(scenario.reports[0]);
    assert.equal(resolution.state, 'approved');
    assert.equal(resolution.effective.id, 'APR-X2');
    assert.equal(resolution.retries.length, 1);
    assert.equal(resolution.retries[0].id, 'APR-X1');
  });

  it('部分批准只发布批准区间，不越权发布原申报后段', () => {
    const scenario = baseScenario();
    scenario.reports[0].approvalAttempts[1].outcome = 'partial';
    scenario.reports[0].approvalAttempts[1].approvedSpan = { start: '2026-03-01', end: '2026-03-10' };
    const { claims, exclusions } = collectClaims(scenario);
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0].approvedSpan, { start: '2026-03-01', end: '2026-03-10' });
    assert.deepEqual(claims[0].originalSpan, { start: '2026-03-01', end: '2026-03-20' });
    assert.equal(exclusions.length, 0);
  });

  it('只有故障重试时进入待重试队列', () => {
    const scenario = baseScenario();
    scenario.reports[0].approvalAttempts = [scenario.reports[0].approvalAttempts[0]];
    const { claims, exclusions, retryQueue } = collectClaims(scenario);
    assert.equal(claims.length, 0);
    assert.equal(retryQueue.length, 1);
    assert.equal(retryQueue[0].reportId, 'RPT-1');
    assert.equal(exclusions[0].state, 'retryable-error');
  });

  it('拒绝状态不产生可公示主张', () => {
    const scenario = baseScenario();
    const attempt = scenario.reports[0].approvalAttempts[1];
    attempt.outcome = 'rejected';
    attempt.approvedSpan = null;
    const { claims, exclusions } = collectClaims(scenario);
    assert.equal(claims.length, 0);
    assert.equal(exclusions[0].state, 'rejected');
  });

  it('撤销当前生效审批后不再产生主张', () => {
    const scenario = baseScenario();
    const { claims, exclusions } = collectClaims(scenario, {
      'APR-X2': { reason: '复核撤销', at: '2026-03-01T00:00:00Z' },
    });
    assert.equal(claims.length, 0);
    assert.equal(exclusions[0].state, 'revoked');
    assert.equal(exclusions[0].reason, '复核撤销');
  });

  it('被取代的审批不参与生效判定', () => {
    const scenario = baseScenario();
    scenario.reports[0].approvalAttempts[1].status = 'superseded';
    const resolution = resolveApproval(scenario.reports[0]);
    assert.equal(resolution.state, 'retryable-error');
    assert.equal(resolution.effective, null);
  });
});

describe('场景校验', () => {
  it('批准区间不得超出原申报区间', () => {
    assert.throws(
      () => baseScenario({
        reports: [{
          id: 'RPT-1',
          roadId: 'R1',
          teamId: 'T1',
          work: '测试',
          originalSpan: { start: '2026-03-01', end: '2026-03-10' },
          submittedAt: '2026-02-01T00:00:00Z',
          approvalAttempts: [{
            id: 'APR-1',
            attempt: 1,
            outcome: 'approved',
            approvedSpan: { start: '2026-03-01', end: '2026-03-20' },
            decidedAt: '2026-02-02T00:00:00Z',
          }],
        }],
      }),
      /超出原申报区间/,
    );
  });

  it('部分批准不能等于整个申报区间', () => {
    assert.throws(
      () => baseScenario({
        reports: [{
          id: 'RPT-1',
          roadId: 'R1',
          teamId: 'T1',
          work: '测试',
          originalSpan: { start: '2026-03-01', end: '2026-03-10' },
          submittedAt: '2026-02-01T00:00:00Z',
          approvalAttempts: [{
            id: 'APR-1',
            attempt: 1,
            outcome: 'partial',
            approvedSpan: { start: '2026-03-01', end: '2026-03-10' },
            decidedAt: '2026-02-02T00:00:00Z',
          }],
        }],
      }),
      /部分批准/,
    );
  });

  it('未知道路与非法 outcome 都会被拒绝', () => {
    assert.throws(
      () => baseScenario({
        reports: [{
          id: 'RPT-1',
          roadId: 'R404',
          teamId: 'T1',
          work: '测试',
          originalSpan: { start: '2026-03-01', end: '2026-03-02' },
          submittedAt: '2026-02-01T00:00:00Z',
        }],
      }),
      /不存在的道路/,
    );
    assert.throws(
      () => baseScenario({
        reports: [{
          id: 'RPT-1',
          roadId: 'R1',
          teamId: 'T1',
          work: '测试',
          originalSpan: { start: '2026-03-01', end: '2026-03-02' },
          submittedAt: '2026-02-01T00:00:00Z',
          approvalAttempts: [{
            id: 'APR-1',
            attempt: 1,
            outcome: 'ok',
            decidedAt: '2026-02-02T00:00:00Z',
          }],
        }],
      }),
      /outcome/,
    );
  });

  it('重复的审批序号会被拒绝', () => {
    assert.throws(
      () => baseScenario({
        reports: [{
          id: 'RPT-1',
          roadId: 'R1',
          teamId: 'T1',
          work: '测试',
          originalSpan: { start: '2026-03-01', end: '2026-03-05' },
          submittedAt: '2026-02-01T00:00:00Z',
          approvalAttempts: [
            { id: 'A1', attempt: 1, outcome: 'error', decidedAt: '2026-02-02T00:00:00Z' },
            { id: 'A2', attempt: 1, outcome: 'error', decidedAt: '2026-02-03T00:00:00Z' },
          ],
        }],
      }),
      /审批序号/,
    );
  });
});
