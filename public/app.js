const $ = (selector) => document.querySelector(selector);

const els = {
  status: $('#connection-status'),
  import: $('#btn-import'),
  revokeSelect: $('#revoke-select'),
  revoke: $('#btn-revoke'),
  publicationSelect: $('#publication-select'),
  view: $('#btn-view'),
  priority: $('#priority-select'),
  rebuild: $('#btn-rebuild'),
  reviseRoad: $('#revise-road'),
  revise: $('#btn-revise'),
  lastAction: $('#last-action'),
  result: $('#business-result'),
  inspect: $('#inspect-result'),
  inspectSummary: $('#inspect-summary'),
  scenario: $('#scenario-summary'),
  history: $('#history-list'),
  toast: $('#toast'),
};

let state = null;
let viewingPublicationId = null;
let viewingPublication = null;
let busy = false;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.setAttribute(key, value);
    else if (key === 'colspan') node.colSpan = value;
    else if (key === 'scope') node.setAttribute('scope', value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function pill(text, tone = 'muted') {
  return el('span', { class: `pill ${tone}`, text });
}

function spanText(span) {
  return span ? `${span.start} ~ ${span.end}` : '—';
}

function toast(message, tone = 'error') {
  els.toast.textContent = message;
  els.toast.className = `toast${tone === 'ok' ? ' ok' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 5000);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `请求失败：HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function withBusy(button, task) {
  if (busy) return;
  busy = true;
  const buttons = [els.import, els.revoke, els.view, els.rebuild, els.revise, button].filter(Boolean);
  buttons.forEach((item) => { item.disabled = true; });
  try {
    await task();
  } catch (error) {
    toast(error.message);
    setStatus('操作失败', 'error');
  } finally {
    busy = false;
    buttons.forEach((item) => { item.disabled = false; });
    // 撤销按钮是否可用取决于当前是否仍有生效批准，不能一概恢复。
    if (els.revokeSelect.options.length === 0 || els.revokeSelect.value === '') {
      els.revoke.disabled = true;
    }
  }
}

function setStatus(text, tone = '') {
  els.status.textContent = text;
  els.status.className = `status${tone ? ` ${tone}` : ''}`;
}

function markAction(text) {
  els.lastAction.textContent = text;
}

function renderStats(stats) {
  return el('ul', { class: 'stats-list' }, [
    el('li', {}, [`公示片段：`, el('strong', { text: String(stats.publishedFragments) }), ' 段']),
    el('li', {}, [`公示总天数：`, el('strong', { text: String(stats.publishedDays) }), ' 天']),
    el('li', {}, [`涉及道路：`, el('strong', { text: String(stats.roadsWithWork) }), ' 条']),
    el('li', {}, [`被裁剪的申报：`, el('strong', { text: String(stats.trimmedClaims) }), ' 条']),
    el('li', {}, [`完全被占用：`, el('strong', { text: String(stats.fullyOverlapped) }), ' 条']),
  ]);
}

function fragmentsTable(fragments, { inspection = null } = {}) {
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '片段' }),
        el('th', { scope: 'col', text: '班组' }),
        el('th', { scope: 'col', text: '公示区间 [起, 止)' }),
        el('th', { scope: 'col', text: '天数' }),
        el('th', { scope: 'col', text: '来源审批' }),
        inspection ? el('th', { scope: 'col', text: '当前有效性' }) : el('th', { scope: 'col', text: '说明' }),
      ]),
    ]),
  ]);
  const body = el('tbody');
  for (const fragment of fragments) {
    const inspectionRow = inspection?.fragments.find((item) => item.id === fragment.id);
    const statusCell = inspectionRow
      ? el('td', {}, [
        inspectionRow.stillApproved ? pill('仍有效', 'ok') : pill('已失效', 'bad'),
        inspectionRow.invalidation
          ? el('div', { class: 'mono', text: inspectionRow.invalidation.reason })
          : null,
      ])
      : el('td', {}, [
        fragment.trimmed ? pill('已裁剪', 'warn') : pill('完整', 'ok'),
        fragment.lost?.length
          ? el('div', { class: 'mono', text: `让出 ${fragment.lost.map(spanText).join('、')}` })
          : null,
      ]);
    body.append(
      el('tr', {}, [
        el('td', { class: 'mono', text: fragment.id }),
        el('td', {}, [fragment.teamName, el('div', { class: 'mono', text: fragment.work })]),
        el('td', { class: 'mono', text: spanText(fragment.span) }),
        el('td', { text: String(fragment.days) }),
        el('td', { class: 'mono', text: `${fragment.approvalId}#${fragment.attempt}` }),
        statusCell,
      ]),
    );
  }
  table.append(body);
  return table;
}

function exclusionsTable(exclusions) {
  if (exclusions.length === 0) return el('p', { class: 'hint', text: '没有未公示的申报。' });
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '申报' }),
        el('th', { scope: 'col', text: '班组' }),
        el('th', { scope: 'col', text: '原申报区间' }),
        el('th', { scope: 'col', text: '审批区间' }),
        el('th', { scope: 'col', text: '结果' }),
      ]),
    ]),
  ]);
  const body = el('tbody');
  for (const item of exclusions) {
    body.append(
      el('tr', {}, [
        el('td', { class: 'mono', text: item.reportId }),
        el('td', { text: item.teamName }),
        el('td', { class: 'mono', text: spanText(item.originalSpan) }),
        el('td', { class: 'mono', text: spanText(item.approvedSpan) }),
        el('td', {}, [
          pill(exclusionLabel(item.state), exclusionTone(item.state)),
          el('div', { class: 'mono', text: item.reason }),
        ]),
      ]),
    );
  }
  table.append(body);
  return table;
}

function exclusionLabel(stateName) {
  return {
    'fully-overlapped': '交叠后无片段',
    'partially-overlapped': '交叠已裁剪',
    rejected: '审批拒绝',
    revoked: '审批撤销',
    closed: '审批关闭',
    'retryable-error': '审批故障待重试',
    unknown: '未知',
  }[stateName] ?? stateName;
}

function exclusionTone(stateName) {
  if (stateName === 'partially-overlapped') return 'warn';
  if (stateName === 'retryable-error') return 'warn';
  if (stateName === 'fully-overlapped' || stateName === 'rejected' || stateName === 'revoked') return 'bad';
  return 'muted';
}

function renderPublication(publication, { historical = false } = {}) {
  const container = els.result;
  container.replaceChildren();
  container.dataset.evidenceVersion = publication.id;

  const head = el('div', { class: 'result-head' }, [
    el('h3', { text: historical ? '历史公示版本快照' : '当前公示' }),
    el('span', { class: 'mono', text: publication.id }),
  ]);
  container.append(head);

  container.append(
    el('p', { class: 'hint' }, [
      `${publication.isCurrent ? '当前版本' : '已被取代'} · 生成于 ${publication.createdAt} · 裁决优先级 `,
      el('span', { class: 'mono', text: publication.priorityMode }),
      publication.supersedes ? ` · 取代 ${publication.supersedes}` : '',
    ]),
  );

  if (historical) {
    container.append(
      el('div', { class: 'callout warn' }, [
        '这是不可变的历史快照：旧链接永远展示当时的片段，不会因之后的审批撤销而被改写。'
        + '其内容与当前审批是否一致，请看下方「旧链接核对」。',
      ]),
    );
  }

  container.append(renderStats(publication.snapshot.stats));

  const roads = publication.snapshot.roads;
  for (const road of roads) {
    const block = el('div', { class: 'road-block' }, [
      el('div', { class: 'road-title' }, [
        el('span', { text: `${road.name}（${road.code}）` }),
        el('span', { class: 'hint', text: `${road.fragments.length} 段` }),
      ]),
    ]);
    block.append(
      road.fragments.length > 0
        ? fragmentsTable(road.fragments)
        : el('p', { class: 'hint', text: '本道路当前没有可公示片段。' }),
    );
    container.append(block);
  }

  container.append(
    el('div', { class: 'road-block' }, [
      el('h3', { class: 'road-title', text: '未公示 / 被裁剪的申报' }),
      exclusionsTable(publication.snapshot.exclusions),
    ]),
  );

  if (publication.retryQueue?.length) {
    container.append(
      el('div', { class: 'callout warn' }, [
        el('strong', { text: '审批故障待重试：' }),
        publication.retryQueue.map((item) => `${item.reportId}（${item.retries.length} 次故障）`).join('、'),
      ]),
    );
  }
  if (publication.revokedApprovals?.length) {
    container.append(
      el('div', { class: 'callout bad' }, [
        el('strong', { text: '生成该版本时已撤销的审批：' }),
        publication.revokedApprovals
          .map((item) => `${item.approvalId}（${item.reason}，${item.at}）`)
          .join('、'),
      ]),
    );
  }
}

function renderInspect(inspection) {
  const container = els.inspect;
  container.replaceChildren();
  const { publication } = inspection;

  els.inspectSummary.textContent =
    `旧链接 ${publication.id} 当时发布 ${publication.snapshot.fragments.length} 段；`
    + `按当前审批核对：仍有效 ${inspection.validFragments.length} 段，已失效 ${inspection.invalidFragments.length} 段；`
    + `与当前版本相比新增 ${inspection.diff.added} 段、消失 ${inspection.diff.removed} 段。`;

  container.append(
    el('div', { class: 'result-head' }, [
      el('h3', { text: `旧链接快照 ${publication.id}` }),
      inspection.isCurrent ? pill('就是当前版本', 'ok') : pill('非当前版本', 'warn'),
    ]),
  );
  container.append(
    el('p', { class: 'hint' }, [
      `核对时间 ${inspection.checkedAt} · 当前版本 ${inspection.currentPublicationId}`,
    ]),
  );

  if (inspection.invalidFragments.length > 0) {
    container.append(
      el('div', { class: 'callout bad' }, [
        '旧链接仍会按原快照展示这些片段，但它们的审批依据已经不再有效，不能继续当作现行施工公示使用。',
      ]),
    );
  } else {
    container.append(el('div', { class: 'callout' }, ['旧链接的全部片段在当前审批下仍然有效。']));
  }

  container.append(
    el('h4', { text: '旧链接当时发布的片段' }),
    fragmentsTable(publication.snapshot.fragments, { inspection }),
  );

  if (inspection.changes.length > 0) {
    const list = el('ul', { class: 'timeline' });
    for (const change of inspection.changes) {
      list.append(
        el('li', {}, [
          change.type === 'removed' ? pill('消失', 'bad') : pill('新增', 'ok'),
          ` ${change.fragmentId}（${change.teamName}，${spanText(change.span)}）`,
          change.reason ? el('div', { class: 'mono', text: change.reason }) : null,
        ]),
      );
    }
    container.append(el('h4', { text: '与当前版本的差异' }), list);
  } else {
    container.append(el('h4', { text: '与当前版本的差异' }), el('p', { class: 'hint', text: '无差异。' }));
  }
}

function renderScenario(view) {
  const { scenario } = view;
  const container = els.scenario;
  container.replaceChildren();
  container.append(
    el('p', { class: 'hint' }, [
      scenario.description ?? '',
    ]),
  );

  const teams = new Map(scenario.teams.map((team) => [team.id, team]));
  const roads = new Map(scenario.roads.map((road) => [road.id, road]));

  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '申报' }),
        el('th', { scope: 'col', text: '道路 / 班组' }),
        el('th', { scope: 'col', text: '原申报区间' }),
        el('th', { scope: 'col', text: '审批链（按 attempt 排序）' }),
      ]),
    ]),
  ]);
  const body = el('tbody');
  for (const report of scenario.reports) {
    const attempts = report.approvalAttempts.map((attempt) => {
      const revoked = view.revocations.find((item) => item.approvalId === attempt.id);
      const status = revoked ? 'revoked' : attempt.status;
      return el('div', { class: 'mono' }, [
        `#${attempt.attempt} ${attempt.outcome}`,
        attempt.approvedSpan ? ` ${spanText(attempt.approvedSpan)}` : '',
        ` [${status}]`,
        revoked ? ` 撤销理由：${revoked.reason}` : '',
        attempt.message ? ` · ${attempt.message}` : '',
      ]);
    });
    body.append(
      el('tr', {}, [
        el('td', { class: 'mono' }, [report.id, el('div', { class: 'hint', text: report.work })]),
        el('td', {}, [
          `${roads.get(report.roadId)?.name ?? report.roadId}`,
          el('div', { class: 'hint', text: teams.get(report.teamId)?.name ?? report.teamId }),
        ]),
        el('td', { class: 'mono', text: spanText(report.originalSpan) }),
        el('td', {}, attempts),
      ]),
    );
  }
  table.append(body);
  container.append(table);
}

function renderHistory(view) {
  els.history.replaceChildren();
  for (const event of [...view.history].reverse()) {
    els.history.append(
      el('li', {}, [
        el('time', { text: event.at }),
        ` · ${event.action} · ${event.note}`,
        event.publicationId ? el('span', { class: 'mono', text: ` → ${event.publicationId}` }) : null,
      ]),
    );
  }
}

function syncControls(view) {
  els.priority.value = view.priorityMode;

  els.revokeSelect.replaceChildren();
  if (view.revocableApprovals.length === 0) {
    els.revokeSelect.append(el('option', { value: '', text: '没有可撤销的生效批准' }));
    els.revoke.disabled = true;
  } else {
    els.revoke.disabled = false;
    for (const item of view.revocableApprovals) {
      els.revokeSelect.append(
        el('option', {
          value: item.approvalId,
          text: `${item.approvalId} · ${item.teamName} · ${spanText(item.approvedSpan)}`,
        }),
      );
    }
  }

  els.publicationSelect.replaceChildren();
  for (const publication of [...view.publications].reverse()) {
    els.publicationSelect.append(
      el('option', {
        value: publication.id,
        text: `${publication.id} · ${publication.action} · ${publication.fragmentCount} 段${publication.isCurrent ? '（当前）' : ''}`,
      }),
    );
  }
  if (viewingPublicationId && view.publications.some((item) => item.id === viewingPublicationId)) {
    els.publicationSelect.value = viewingPublicationId;
  }

  els.reviseRoad.replaceChildren(el('option', { value: '', text: '全部道路' }));
  for (const road of view.scenario.roads) {
    els.reviseRoad.append(el('option', { value: road.id, text: `${road.name}（${road.code}）` }));
  }
  els.reviseRoad.value = '';
}

function renderState(view) {
  state = view;
  const current = view.current;
  const isCurrentView = !viewingPublicationId
    || !viewingPublication
    || viewingPublication.id === current?.id;

  renderScenario(view);
  renderHistory(view);
  syncControls(view);

  if (isCurrentView) {
    renderPublication(current, { historical: false });
  } else {
    renderPublication(viewingPublication, { historical: true });
  }
}

async function refreshView() {
  const view = await api('/api/state');
  renderState(view);
  setStatus('已连接', 'ok');
}

function resetInspect(message = '尚未核对旧链接。') {
  els.inspect.replaceChildren(el('p', { class: 'placeholder', text: message }));
  els.inspectSummary.textContent = '选择一个历史版本后，这里会展示它当时发布的片段、当前是否仍有效，以及新旧版本的差异。';
}

async function showPublication(id, { inspect = true } = {}) {
  const [view, publication] = await Promise.all([
    api('/api/state'),
    api(`/api/publications/${encodeURIComponent(id)}`),
  ]);
  viewingPublicationId = publication.id;
  viewingPublication = publication;
  renderState(view);
  const url = new URL(window.location.href);
  url.searchParams.set('publication', publication.id);
  window.history.replaceState({}, '', url);
  if (inspect) {
    const inspection = await api(`/api/publications/${encodeURIComponent(id)}/inspect`);
    renderInspect(inspection);
    return inspection;
  }
  return null;
}

function clearViewing() {
  viewingPublicationId = null;
  viewingPublication = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('publication');
  window.history.replaceState({}, '', url);
}

els.import.addEventListener('click', () => withBusy(els.import, async () => {
  const result = await api('/api/import', {
    method: 'POST',
    body: { priorityMode: els.priority.value },
  });
  clearViewing();
  resetInspect('已重新导入场景；选择一个历史版本可核对旧链接。');
  renderState(result.state);
  markAction('已导入交叠区间');
  toast(`已导入场景并生成 ${result.publication.id}`, 'ok');
}));

els.revoke.addEventListener('click', () => withBusy(els.revoke, async () => {
  const approvalId = els.revokeSelect.value;
  if (!approvalId) {
    toast('请选择要撤销的审批');
    return;
  }
  const previousId = state.current?.id ?? null;
  const selected = state.revocableApprovals.find((item) => item.approvalId === approvalId);
  const result = await api('/api/revoke', {
    method: 'POST',
    body: {
      approvalId,
      reason: `公示途中撤销：${selected?.teamName ?? ''} 的 ${approvalId}`,
      actor: '网页演示',
    },
  });

  if (previousId && previousId !== result.publication.id) {
    await showPublication(previousId);
    document.getElementById('inspect-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    markAction(`已撤销 ${approvalId} · 旧链接 ${previousId} 仍展示撤销前片段`);
    toast(`已撤销审批 ${approvalId}，新版本 ${result.publication.id}；旧链接核对已展开`, 'ok');
  } else {
    clearViewing();
    renderState(result.state);
    markAction(`已撤销 ${approvalId}`);
    toast(`已撤销审批 ${approvalId}，并生成 ${result.publication.id}`, 'ok');
  }
}));

els.view.addEventListener('click', () => withBusy(els.view, async () => {
  const id = els.publicationSelect.value;
  if (!id) {
    toast('没有可查看的公示版本');
    return;
  }
  await showPublication(id);
  markAction(`查看公示片段：${id}`);
  document.getElementById('inspect-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

els.rebuild.addEventListener('click', () => withBusy(els.rebuild, async () => {
  const result = await api('/api/rebuild', {
    method: 'POST',
    body: { priorityMode: els.priority.value, note: '网页触发全量重建' },
  });
  clearViewing();
  resetInspect();
  renderState(result.state);
  markAction('已按当前审批重建');
  toast(`已生成 ${result.publication.id}`, 'ok');
}));

els.revise.addEventListener('click', () => withBusy(els.revise, async () => {
  const roadId = els.reviseRoad.value;
  const result = await api('/api/revise', {
    method: 'POST',
    body: roadId
      ? { roadId, note: `网页触发逐段修订：${roadId}` }
      : { note: '网页触发逐段修订：全部道路' },
  });
  clearViewing();
  resetInspect();
  renderState(result.state);
  const revision = result.publication.snapshot.revision;
  markAction('已逐段修订并核对一致性');
  toast(
    `逐段修订完成：重算 ${revision.recomputedRoads.length} 条道路，与全量重建一致`,
    'ok',
  );
}));

refreshView()
  .then(async () => {
    const requested = new URL(window.location.href).searchParams.get('publication');
    if (!requested) return;
    try {
      await showPublication(requested);
      els.publicationSelect.value = requested;
      markAction(`旧链接核对：${requested}`);
    } catch {
      toast(`链接中的公示版本不存在：${requested}`);
    }
  })
  .catch((error) => {
    setStatus('连接失败', 'error');
    els.result.replaceChildren(el('p', { class: 'placeholder', text: `加载失败：${error.message}` }));
  });
