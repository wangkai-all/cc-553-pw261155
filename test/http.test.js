import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';

let baseUrl;
let server;

before(async () => {
  const app = await createApp();
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

describe('HTTP 接口', () => {
  it('GET / 返回含 data-evidence-result 的页面', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /data-evidence-result="publication-fragments"/);
    assert.match(html, /导入交叠区间/);
    assert.match(html, /撤销一段审批|撤销所选批准/);
    assert.match(html, /查看公示片段|查看所选版本/);
  });

  it('GET /api/state 返回当前公示与可撤销审批', async () => {
    const { status, body } = await get('/api/state');
    assert.equal(status, 200);
    assert.ok(body.current.id.startsWith('PUB-'));
    assert.ok(body.current.snapshot.fragments.length > 0);
    assert.ok(Array.isArray(body.revocableApprovals));
    assert.ok(body.history.length >= 1);
  });

  it('POST /api/import 重新载入内置场景', async () => {
    const { status, body } = await post('/api/import', { priorityMode: 'first-submitted' });
    assert.equal(status, 201);
    assert.equal(body.source, 'built-in-demo');
    assert.equal(body.state.priorityMode, 'first-submitted');
    assert.equal(body.publication.sequence, 1);
  });

  it('POST /api/import 可导入自定义交叠区间', async () => {
    const { status, body } = await post('/api/import', {
      scenario: {
        title: '自定义',
        teams: [{ id: 'T1', name: '甲' }, { id: 'T2', name: '乙' }],
        roads: [{ id: 'R1', code: 'R-1', name: '甲路' }],
        reports: [
          {
            id: 'P1', roadId: 'R1', teamId: 'T1', work: '开挖',
            originalSpan: { start: '2026-05-01', end: '2026-05-10' },
            submittedAt: '2026-04-01T00:00:00Z',
            approvalAttempts: [{
              id: 'A1', attempt: 1, outcome: 'approved',
              approvedSpan: { start: '2026-05-01', end: '2026-05-10' },
              decidedAt: '2026-04-02T00:00:00Z', status: 'active',
            }],
          },
          {
            id: 'P2', roadId: 'R1', teamId: 'T2', work: '铺装',
            originalSpan: { start: '2026-05-10', end: '2026-05-20' },
            submittedAt: '2026-04-03T00:00:00Z',
            approvalAttempts: [{
              id: 'A2', attempt: 1, outcome: 'approved',
              approvedSpan: { start: '2026-05-10', end: '2026-05-20' },
              decidedAt: '2026-04-04T00:00:00Z', status: 'active',
            }],
          },
        ],
      },
    });
    assert.equal(status, 201);
    assert.equal(body.source, 'request-body');
    assert.deepEqual(
      body.publication.snapshot.fragments.map((fragment) => [fragment.reportId, fragment.days]),
      [['P1', 9], ['P2', 10]],
    );
    assert.equal(body.publication.snapshot.stats.trimmedClaims, 0);
  });

  it('非法导入返回 400 且不破坏当前状态', async () => {
    const before = await get('/api/state');
    const { status, body } = await post('/api/import', {
      scenario: { teams: [], roads: [], reports: [] },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    const afterState = await get('/api/state');
    assert.equal(afterState.body.current.id, before.body.current.id);
  });

  it('非法 JSON 请求体返回 400', async () => {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(response.status, 400);
  });

  it('撤销 → 新版本 → 旧链接核对链路', async () => {
    await post('/api/import', { priorityMode: 'first-submitted' });
    const state = await get('/api/state');
    const oldId = state.body.current.id;

    const revoked = await post('/api/revoke', { approvalId: 'APR-B1', reason: '复核' });
    assert.equal(revoked.status, 201);
    assert.notEqual(revoked.body.publication.id, oldId);
    assert.equal(revoked.body.publication.supersedes, oldId);

    const inspection = await get(`/api/publications/${encodeURIComponent(oldId)}/inspect`);
    assert.equal(inspection.status, 200);
    assert.equal(inspection.body.publication.id, oldId);
    assert.equal(inspection.body.isCurrent, false);
    assert.deepEqual(inspection.body.invalidFragments.map((fragment) => fragment.id), ['RPT-B#1']);
    assert.equal(inspection.body.publication.snapshot.fragments.length, 5);

    const missing = await get('/api/publications/PUB-9999-nope/inspect');
    assert.equal(missing.status, 404);
  });

  it('重复撤销返回 409', async () => {
    await post('/api/import', { priorityMode: 'first-submitted' });
    const first = await post('/api/revoke', { approvalId: 'APR-B1', reason: '第一次' });
    assert.equal(first.status, 201);
    const second = await post('/api/revoke', { approvalId: 'APR-B1', reason: '第二次' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CONFLICT');
  });

  it('撤销缺少 approvalId 返回 400', async () => {
    const { status, body } = await post('/api/revoke', {});
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  it('逐段修订返回与重建一致的标记', async () => {
    await post('/api/import', { priorityMode: 'first-submitted' });
    const { status, body } = await post('/api/revise', { roadId: 'R1' });
    assert.equal(status, 201);
    assert.equal(body.publication.snapshot.revision.strategy, 'incremental');
    assert.deepEqual(body.publication.snapshot.revision.recomputedRoads, ['R1']);
    assert.equal(body.publication.snapshot.revision.verifiedAgainstRebuild, true);
  });

  it('修订未知道路返回 404', async () => {
    const { status } = await post('/api/revise', { roadId: 'R404' });
    assert.equal(status, 404);
  });

  it('不支持的方法返回 405', async () => {
    const response = await fetch(`${baseUrl}/api/revoke`);
    assert.equal(response.status, 405);
  });

  it('未知 API 返回 404，且静态目录穿越被阻止', async () => {
    const unknown = await get('/api/nope');
    assert.equal(unknown.status, 404);
    const traversal = await get('/../server.js');
    assert.equal(traversal.status, 404);
  });

  it('GET /api/publications 列出不可变版本摘要', async () => {
    const { status, body } = await get('/api/publications');
    assert.equal(status, 200);
    assert.ok(body.publications.length >= 1);
    assert.equal(body.publications.filter((publication) => publication.isCurrent).length, 1);
    for (const publication of body.publications) {
      assert.ok(publication.digest);
      assert.equal(typeof publication.fragmentCount, 'number');
    }
  });
});
