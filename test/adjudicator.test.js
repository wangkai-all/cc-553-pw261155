import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adjudicate, reviseAdjudication, coreProjection } from '../src/adjudicator.js';
import { collectClaims } from '../src/approvals.js';
import { digest } from '../src/digest.js';
import { normalizeScenario } from '../src/scenario.js';

function scenarioWith(reports, roads) {
  return normalizeScenario({
    title: '裁决测试',
    teams: [
      { id: 'T1', name: '一班' },
      { id: 'T2', name: '二班' },
      { id: 'T3', name: '三班' },
    ],
    roads: roads ?? [{ id: 'R1', code: 'R-1', name: '测试路' }],
    reports,
  });
}

function approvedReport({ id, teamId = 'T1', roadId = 'R1', original, approved, submittedAt, decidedAt, attempt = 1, approvalId = `APR-${id}` }) {
  return {
    id,
    roadId,
    teamId,
    work: `${id} 施工`,
    originalSpan: original,
    submittedAt,
    approvalAttempts: [{
      id: approvalId,
      attempt,
      outcome: 'approved',
      approvedSpan: approved ?? original,
      decidedAt,
      status: 'active',
    }],
  };
}

function run(scenario, priorityMode = 'first-submitted') {
  return adjudicate(scenario, { ...collectClaims(scenario), priorityMode });
}

describe('区间裁决', () => {
  it('同日相接的两段不被当作重叠，均完整发布', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-10', end: '2026-03-20' },
        submittedAt: '2026-02-03T00:00:00Z', decidedAt: '2026-02-04T00:00:00Z',
      }),
    ]);
    const result = run(scenario);
    assert.deepEqual(
      result.fragments.map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end, fragment.trimmed]),
      [
        ['RPT-A', '2026-03-01', '2026-03-10', false],
        ['RPT-B', '2026-03-10', '2026-03-20', false],
      ],
    );
    assert.equal(result.stats.trimmedClaims, 0);
  });

  it('重叠区间被切开，只发布先申报者未占用的部分', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-08', end: '2026-03-25' },
        submittedAt: '2026-02-03T00:00:00Z', decidedAt: '2026-02-04T00:00:00Z',
      }),
    ]);
    const result = run(scenario);
    assert.deepEqual(
      result.fragments.map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]),
      [
        ['RPT-A', '2026-03-01', '2026-03-10'],
        ['RPT-B', '2026-03-10', '2026-03-25'],
      ],
    );
    const trimmed = result.exclusions.find((item) => item.reportId === 'RPT-B');
    assert.equal(trimmed.state, 'partially-overlapped');
    assert.deepEqual(trimmed.lost, [{ start: '2026-03-08', end: '2026-03-10' }]);
  });

  it('被完全覆盖的申报不发布片段，也不阻挡后续班组', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-01', end: '2026-03-20' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-05', end: '2026-03-08' },
        submittedAt: '2026-02-02T00:00:00Z', decidedAt: '2026-02-03T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-C', teamId: 'T3',
        original: { start: '2026-03-20', end: '2026-03-25' },
        submittedAt: '2026-02-04T00:00:00Z', decidedAt: '2026-02-05T00:00:00Z',
      }),
    ]);
    const result = run(scenario);
    assert.deepEqual(
      result.fragments.map((fragment) => fragment.reportId),
      ['RPT-A', 'RPT-C'],
    );
    const excluded = result.exclusions.find((item) => item.reportId === 'RPT-B');
    assert.equal(excluded.state, 'fully-overlapped');
    assert.equal(result.stats.fullyOverlapped, 1);
    assert.equal(result.stats.trimmedClaims, 0);
  });

  it('同一申报被切成多段时逐段编号', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-05', end: '2026-03-08' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-12', end: '2026-03-15' },
        submittedAt: '2026-02-02T00:00:00Z', decidedAt: '2026-02-03T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-C', teamId: 'T3',
        original: { start: '2026-03-01', end: '2026-03-20' },
        submittedAt: '2026-02-05T00:00:00Z', decidedAt: '2026-02-06T00:00:00Z',
      }),
    ]);
    const result = run(scenario);
    const c = result.fragments.filter((fragment) => fragment.reportId === 'RPT-C');
    assert.deepEqual(
      c.map((fragment) => [fragment.id, fragment.span.start, fragment.span.end]),
      [
        ['RPT-C#1', '2026-03-01', '2026-03-05'],
        ['RPT-C#2', '2026-03-08', '2026-03-12'],
        ['RPT-C#3', '2026-03-15', '2026-03-20'],
      ],
    );
    assert.equal(result.stats.publishedFragments, 5);
  });

  it('不同道路互不干扰', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1', roadId: 'R1',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2', roadId: 'R2',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-02T00:00:00Z', decidedAt: '2026-02-03T00:00:00Z',
      }),
    ], [
      { id: 'R1', code: 'R-1', name: '一号路' },
      { id: 'R2', code: 'R-2', name: '二号路' },
    ]);
    const result = run(scenario);
    assert.equal(result.fragments.length, 2);
    assert.equal(result.stats.fullyOverlapped, 0);
    assert.equal(result.stats.roadsWithWork, 2);
  });

  it('latest-approval 模式下后获批者优先占用', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-08', end: '2026-03-25' },
        submittedAt: '2026-02-03T00:00:00Z', decidedAt: '2026-02-09T00:00:00Z',
      }),
    ]);
    const result = run(scenario, 'latest-approval');
    assert.deepEqual(
      result.fragments.map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]),
      [
        ['RPT-A', '2026-03-01', '2026-03-08'],
        ['RPT-B', '2026-03-08', '2026-03-25'],
      ],
    );
  });

  it('逐段修订与全量重建结果逐字节一致', () => {
    const scenario = scenarioWith([
      approvedReport({
        id: 'RPT-A', teamId: 'T1',
        original: { start: '2026-03-01', end: '2026-03-10' },
        submittedAt: '2026-02-01T00:00:00Z', decidedAt: '2026-02-02T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-B', teamId: 'T2',
        original: { start: '2026-03-08', end: '2026-03-25' },
        submittedAt: '2026-02-03T00:00:00Z', decidedAt: '2026-02-04T00:00:00Z',
      }),
      approvedReport({
        id: 'RPT-C', teamId: 'T3', roadId: 'R2',
        original: { start: '2026-03-01', end: '2026-03-05' },
        submittedAt: '2026-02-04T00:00:00Z', decidedAt: '2026-02-05T00:00:00Z',
      }),
    ], [
      { id: 'R1', code: 'R-1', name: '一号路' },
      { id: 'R2', code: 'R-2', name: '二号路' },
    ]);
    const claims = collectClaims(scenario);
    const full = adjudicate(scenario, { ...claims, priorityMode: 'first-submitted' });
    const incremental = reviseAdjudication(full, scenario, {
      ...claims,
      priorityMode: 'first-submitted',
    }, ['R1']);
    assert.equal(
      digest(coreProjection(full)),
      digest(coreProjection(incremental)),
    );
    assert.deepEqual(incremental.revision.recomputedRoads, ['R1']);
    assert.deepEqual(incremental.revision.carriedRoads, ['R2']);
  });
});
