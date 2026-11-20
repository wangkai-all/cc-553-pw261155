import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadScenarioFile, normalizeScenario } from '../src/scenario.js';
import { PublicationStore } from '../src/store.js';
import { conflict, NotFoundError } from './helpers.js';

const DEMO_PATH = new URL('../data/demo-scenario.json', import.meta.url);

async function demoStore(options) {
  return new PublicationStore(await loadScenarioFile(DEMO_PATH), options);
}

describe('公示版本仓库 · 合成场景端到端', () => {
  it('初始版本按审批有效区间发布，并保留同日相接', async () => {
    const store = await demoStore();
    const current = store.current();
    assert.equal(current.sequence, 1);
    assert.equal(current.isCurrent, true);
    assert.equal(current.immutable, true);

    const r1 = current.snapshot.roads.find((road) => road.roadId === 'R1');
    assert.deepEqual(
      r1.fragments.map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]),
      [
        ['RPT-A', '2026-03-01', '2026-03-10'],
        ['RPT-B', '2026-03-10', '2026-03-25'],
        ['RPT-C', '2026-03-25', '2026-03-28'],
        ['RPT-D', '2026-03-28', '2026-03-31'],
      ],
    );
  });

  it('部分批准不会发布原申报的后段', async () => {
    const store = await demoStore();
    const fragment = store.current().snapshot.fragments.find((item) => item.reportId === 'RPT-A');
    assert.deepEqual(fragment.span, { start: '2026-03-01', end: '2026-03-10' });
    assert.deepEqual(fragment.originalSpan, { start: '2026-03-01', end: '2026-03-21' });
    assert.equal(fragment.approvalId, 'APR-A2');
    assert.equal(fragment.outcome, 'partial');
    const tail = { start: '2026-03-10', end: '2026-03-21' };
    const fromA = store.current().snapshot.fragments.filter((item) => item.reportId === 'RPT-A');
    assert.equal(fromA.length, 1);
    assert.ok(fromA.every((item) => item.span.end <= tail.start || item.span.start >= tail.end));
  });

  it('故障重试记录保留在待重试队列，且不产生片段', async () => {
    const store = await demoStore();
    const current = store.current();
    assert.deepEqual(current.retryQueue.map((item) => item.reportId), ['RPT-F']);
    assert.equal(current.snapshot.fragments.some((fragment) => fragment.reportId === 'RPT-F'), false);
    const excluded = current.snapshot.exclusions.find((item) => item.reportId === 'RPT-F');
    assert.equal(excluded.state, 'retryable-error');
    assert.equal(excluded.retries.length, 2);
  });

  it('被拒绝的申报不进入公示', async () => {
    const store = await demoStore();
    const excluded = store.current().snapshot.exclusions.find((item) => item.reportId === 'RPT-E');
    assert.equal(excluded.state, 'rejected');
    assert.equal(store.current().snapshot.fragments.some((fragment) => fragment.reportId === 'RPT-E'), false);
  });

  it('撤销审批生成新版本，旧版本快照保持不变', async () => {
    const store = await demoStore();
    const before = store.getPublication(store.currentId);
    const result = store.revoke('APR-B1', { reason: '复核发现管线冲突', actor: '测试' });

    assert.equal(result.publication.sequence, before.sequence + 1);
    assert.equal(result.publication.supersedes, before.id);
    assert.equal(store.current().id, result.publication.id);
    assert.equal(store.getPublication(before.id).digest, before.digest);
    assert.deepEqual(store.getPublication(before.id).snapshot.fragments, before.snapshot.fragments);
    assert.equal(store.getPublication(before.id).isCurrent, false);
    assert.deepEqual(result.publication.revokedApprovals.map((item) => item.approvalId), ['APR-B1']);
  });

  it('撤销后果由实际裁决得出：缺口由后续班组按规则补位', async () => {
    const store = await demoStore();
    const before = store.current().snapshot.fragments
      .filter((fragment) => fragment.roadId === 'R1')
      .map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]);
    assert.deepEqual(before, [
      ['RPT-A', '2026-03-01', '2026-03-10'],
      ['RPT-B', '2026-03-10', '2026-03-25'],
      ['RPT-C', '2026-03-25', '2026-03-28'],
      ['RPT-D', '2026-03-28', '2026-03-31'],
    ]);

    store.revoke('APR-B1', { reason: '复核发现管线冲突' });
    const after = store.current().snapshot.fragments
      .filter((fragment) => fragment.roadId === 'R1')
      .map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]);
    // C 原本因 B 占用只剩 03-25 起的一段；B 撤销后 C 恢复完整批准区间。
    assert.deepEqual(after, [
      ['RPT-A', '2026-03-01', '2026-03-10'],
      ['RPT-C', '2026-03-18', '2026-03-28'],
      ['RPT-D', '2026-03-28', '2026-03-31'],
    ]);
  });

  it('旧链接：仍返回撤销前片段，但逐段标注失效', async () => {
    const store = await demoStore();
    const oldId = store.currentId;
    store.revoke('APR-B1', { reason: '复核发现管线冲突' });

    const inspection = store.inspectPublication(oldId);
    assert.equal(inspection.publication.id, oldId);
    assert.equal(inspection.isCurrent, false);
    assert.equal(inspection.currentPublicationId, store.currentId);
    assert.equal(inspection.publication.snapshot.fragments.length, 5);

    const revoked = inspection.invalidFragments.map((fragment) => fragment.id);
    assert.deepEqual(revoked, ['RPT-B#1']);
    const invalid = inspection.fragments.find((fragment) => fragment.id === 'RPT-B#1');
    assert.equal(invalid.stillApproved, false);
    assert.match(invalid.invalidation.reason, /撤销/);
    assert.equal(invalid.invalidation.revokedAt, store.revocations['APR-B1'].at);
    assert.equal(inspection.validFragments.length, 4);
    assert.deepEqual(inspection.changes.map((change) => [change.type, change.fragmentId]), [
      ['removed', 'RPT-B#1'],
    ]);
  });

  it('对当前版本做旧链接核对时无失效片段', async () => {
    const store = await demoStore();
    const inspection = store.inspectPublication(store.currentId);
    assert.equal(inspection.isCurrent, true);
    assert.equal(inspection.invalidFragments.length, 0);
    assert.equal(inspection.changes.length, 0);
  });

  it('逐段修订生成的新版本与全量重建一致', async () => {
    const store = await demoStore();
    const incremental = store.revise(['R1'], '只重算 R1');
    const revision = incremental.snapshot.revision;
    assert.equal(revision.strategy, 'incremental');
    assert.deepEqual(revision.recomputedRoads, ['R1']);
    assert.deepEqual(revision.carriedRoads, ['R2']);
    assert.equal(revision.verifiedAgainstRebuild, true);

    const rebuilt = store.rebuild('全量重建');
    assert.equal(
      rebuilt.snapshot.fragments.length,
      incremental.snapshot.fragments.length,
    );
    const normalize = (snapshot) => JSON.stringify({
      fragments: snapshot.fragments,
      exclusions: snapshot.exclusions,
      stats: snapshot.stats,
    });
    assert.equal(normalize(rebuilt.snapshot), normalize(incremental.snapshot));
  });

  it('撤销后再逐段修订仍保持一致', async () => {
    const store = await demoStore();
    store.revoke('APR-B1', { reason: '测试' });
    const incremental = store.revise(['R1'], '撤销后修订 R1');
    assert.equal(incremental.snapshot.revision.verifiedAgainstRebuild, true);
  });

  it('切换裁决优先级后重建，结果按新优先级计算', async () => {
    const store = await demoStore({ priorityMode: 'latest-approval' });
    const r1 = store.current().snapshot.roads.find((road) => road.roadId === 'R1');
    assert.deepEqual(
      r1.fragments.map((fragment) => [fragment.reportId, fragment.span.start, fragment.span.end]),
      [
        ['RPT-A', '2026-03-01', '2026-03-08'],
        ['RPT-B', '2026-03-08', '2026-03-18'],
        ['RPT-C', '2026-03-18', '2026-03-28'],
        ['RPT-D', '2026-03-28', '2026-03-31'],
      ],
    );
  });

  it('版本链可追溯：每次操作都追加历史与不可变版本', async () => {
    const store = await demoStore();
    const first = store.currentId;
    const second = store.rebuild('手动重建').id;
    const third = store.revise([], '全量逐段修订').id;
    assert.notEqual(first, second);
    assert.notEqual(second, third);
    assert.equal(store.getPublication(second).supersedes, first);
    assert.equal(store.getPublication(third).supersedes, second);
    assert.deepEqual(
      store.listPublications().map((publication) => publication.sequence),
      [1, 2, 3],
    );
    assert.equal(store.listPublications().filter((publication) => publication.isCurrent).length, 1);
  });
});

describe('公示版本仓库 · 撤销异常', () => {
  it('重复撤销返回冲突', async () => {
    const store = await demoStore();
    store.revoke('APR-B1', { reason: '第一次' });
    assert.throws(() => store.revoke('APR-B1', { reason: '第二次' }), conflict);
  });

  it('撤销不存在的审批返回 404', async () => {
    const store = await demoStore();
    assert.throws(() => store.revoke('APR-NOPE'), NotFoundError);
  });

  it('撤销故障重试记录被拒绝', async () => {
    const store = await demoStore();
    assert.throws(() => store.revoke('APR-F1', { reason: 'x' }), conflict);
  });

  it('撤销被后续审批取代的旧审批被拒绝', async () => {
    const store = await demoStore();
    assert.throws(() => store.revoke('APR-A1', { reason: 'x' }), conflict);
  });

  it('撤销被拒绝的审批被拒绝', async () => {
    const store = await demoStore();
    assert.throws(() => store.revoke('APR-E1', { reason: 'x' }), conflict);
  });

  it('撤销失败不会污染审批状态', async () => {
    const store = await demoStore();
    const before = store.currentId;
    assert.throws(() => store.revoke('APR-NOPE'));
    assert.equal(store.currentId, before);
    assert.deepEqual(store.revocations, {});
  });

  it('撤销未知道路的修订请求返回 404', async () => {
    const store = await demoStore();
    assert.throws(() => store.revise(['R404']), NotFoundError);
  });

  it('查询不存在的公示版本返回 404', async () => {
    const store = await demoStore();
    assert.throws(() => store.getPublication('PUB-9999-deadbeef'), NotFoundError);
    assert.throws(() => store.inspectPublication('PUB-9999-deadbeef'), NotFoundError);
  });
});

describe('场景文件校验', () => {
  it('内置合成场景可被严格校验并载入', async () => {
    const scenario = await loadScenarioFile(DEMO_PATH);
    assert.ok(scenario.roads.length >= 2);
    assert.ok(scenario.reports.some((report) => report.approvalAttempts.some((attempt) => attempt.outcome === 'error')));
    assert.ok(scenario.reports.some((report) => report.approvalAttempts.some((attempt) => attempt.outcome === 'partial')));
  });

  it('空对象不能伪装成场景', () => {
    assert.throws(() => normalizeScenario({}), /teams/);
  });

  it('非法 JSON 文本给出可读错误', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'scenario-invalid-'));
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(
      () => loadScenarioFile(file),
      /不是合法 JSON/,
    );
  });
});
