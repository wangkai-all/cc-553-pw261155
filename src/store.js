import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { digest, shortDigest } from './digest.js';
import { adjudicate, reviseAdjudication, coreProjection } from './adjudicator.js';
import { collectClaims, PRIORITY_MODES, effectiveAttempt } from './approvals.js';
import { normalizeScenario } from './scenario.js';

function clone(value) {
  return structuredClone(value);
}

function versionId(sequence, projection) {
  return `PUB-${String(sequence).padStart(4, '0')}-${shortDigest(projection)}`;
}

/**
 * 公示仓库：审批状态是可变的事实来源，公示版本是不可变的派生快照。
 *
 * - rebuild：按最新审批全量重建；
 * - revise：逐段修订，只重算受影响道路并逐字节核对与全量一致；
 * - revoke：撤销一段审批后生成新版本，旧版本保持原样，但记录撤销事件。
 */
export class PublicationStore {
  constructor(scenario, { priorityMode = 'first-submitted' } = {}) {
    this.scenario = normalizeScenario(scenario);
    if (!PRIORITY_MODES.includes(priorityMode)) {
      throw new ValidationError(`未知裁决优先级：${priorityMode}`);
    }
    this.priorityMode = priorityMode;
    this.revocations = {};
    this.publications = [];
    this.auditLog = [];
    this.history = [];
    this.sequence = 0;
    this.currentId = null;
    this.#publish('import', '载入场景并生成初始公示', { strategy: 'rebuild' });
  }

  #append(action, note, extra = {}) {
    const entry = {
      seq: this.history.length + 1,
      at: new Date().toISOString(),
      action,
      note,
      ...extra,
    };
    this.history.push(entry);
    return entry;
  }

  #compute({ strategy = 'rebuild', affectedRoadIds = null } = {}) {
    const { claims, exclusions, retryQueue } = collectClaims(this.scenario, this.revocations);
    const previous = this.publications.at(-1) ?? null;

    let result;
    if (strategy === 'revise' && previous) {
      result = reviseAdjudication(previous.snapshot, this.scenario, {
        claims,
        exclusions,
        priorityMode: this.priorityMode,
      }, affectedRoadIds);
      const rebuilt = adjudicate(this.scenario, { claims, exclusions, priorityMode: this.priorityMode });
      const left = digest(coreProjection(result));
      const right = digest(coreProjection(rebuilt));
      if (left !== right) {
        throw new ConflictError(
          '逐段修订结果与全量重建不一致，已拒绝发布',
          { incremental: shortDigest(coreProjection(result)), rebuild: shortDigest(coreProjection(rebuilt)) },
        );
      }
      result.revision.verifiedAgainstRebuild = true;
      result.revision.equivalenceDigest = left;
    } else {
      result = adjudicate(this.scenario, { claims, exclusions, priorityMode: this.priorityMode });
      result.revision = {
        strategy: 'rebuild',
        recomputedRoads: this.scenario.roads.map((road) => road.id),
        carriedRoads: [],
      };
    }

    return { result, retryQueue, claims };
  }

  #publish(action, note, options = {}) {
    const { result, retryQueue } = this.#compute(options);
    const seq = ++this.sequence;
    const projection = coreProjection(result);
    const id = versionId(seq, projection);
    const supersedes = this.currentId;
    const publication = {
      id,
      sequence: seq,
      createdAt: new Date().toISOString(),
      priorityMode: this.priorityMode,
      supersedes,
      action,
      note,
      snapshot: clone(result),
      digest: digest(projection),
      revokedApprovals: Object.entries(this.revocations).map(([approvalId, revocation]) => ({
        approvalId,
        ...revocation,
      })),
      retryQueue,
      immutable: true,
    };
    for (const previous of this.publications) previous.isCurrent = false;
    publication.isCurrent = true;
    this.publications.push(publication);
    this.currentId = id;
    this.#append(action, note, { publicationId: id, supersedes });
    return clone(publication);
  }

  rebuild(note = '按最新审批全量重建公示') {
    return this.#publish('rebuild', note, { strategy: 'rebuild' });
  }

  revise(affectedRoadIds = null, note = '逐段修订公示') {
    const roadIds = affectedRoadIds ?? this.scenario.roads.map((road) => road.id);
    for (const roadId of roadIds) {
      if (!this.scenario.roads.some((road) => road.id === roadId)) {
        throw new NotFoundError(`不存在道路 ${roadId}`);
      }
    }
    return this.#publish('revise', note, { strategy: 'revise', affectedRoadIds: roadIds });
  }

  revoke(approvalId, { reason, actor } = {}) {
    if (typeof approvalId !== 'string' || approvalId.trim() === '') {
      throw new ValidationError('approvalId 必须是非空字符串');
    }
    const report = this.scenario.reports.find((candidate) =>
      candidate.approvalAttempts.some((attempt) => attempt.id === approvalId));
    if (!report) {
      throw new NotFoundError(`不存在审批 ${approvalId}`);
    }
    if (this.revocations[approvalId]) {
      throw new ConflictError(`审批 ${approvalId} 已被撤销，不能重复撤销`);
    }
    const attempt = report.approvalAttempts.find((candidate) => candidate.id === approvalId);
    const effective = effectiveAttempt(report);
    if (!effective || effective.id !== approvalId) {
      throw new ConflictError(
        `审批 ${approvalId} 不是该申报当前生效的审批，撤销不会影响公示；`
          + `当前生效审批为 ${effective?.id ?? '无'}`,
      );
    }
    if (attempt.outcome === 'error' || attempt.outcome === 'rejected') {
      throw new ConflictError(`审批 ${approvalId} 的结果是 ${attempt.outcome}，不存在可撤销的批准`);
    }
    if (attempt.status !== 'active') {
      throw new ConflictError(`审批 ${approvalId} 当前状态为 ${attempt.status}，不具备撤销条件`);
    }

    const revocation = {
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '未说明撤销原因',
      actor: typeof actor === 'string' && actor.trim() ? actor.trim() : '审批端',
      at: new Date().toISOString(),
    };
    this.revocations[approvalId] = revocation;

    try {
      const publication = this.#publish(
        'revoke',
        `撤销审批 ${approvalId} 并重建公示`,
        { strategy: 'rebuild' },
      );
      return {
        revocation: { approvalId, reportId: report.id, ...revocation },
        publication,
        affectedRoadIds: [...new Set([report.roadId])],
      };
    } catch (error) {
      delete this.revocations[approvalId];
      throw error;
    }
  }

  getPublication(id) {
    const publication = this.publications.find((candidate) => candidate.id === id);
    if (!publication) throw new NotFoundError(`不存在公示版本 ${id}`);
    return clone(publication);
  }

  current() {
    return this.currentId ? this.getPublication(this.currentId) : null;
  }

  /**
   * 评估旧链接：返回旧版本自身的快照，并对照当前审批事实标出哪些片段已失效。
   * 旧链接的内容永远不被改写，这里只做只读核对。
   */
  inspectPublication(id) {
    const publication = this.getPublication(id);
    const { claims } = collectClaims(this.scenario, this.revocations);
    const activeApprovalIds = new Set(claims.map((claim) => claim.approvalId));
    const activeByReport = new Map(claims.map((claim) => [claim.reportId, claim]));
    const current = this.current();

    const fragments = publication.snapshot.fragments.map((fragment) => {
      const stillApproved = activeApprovalIds.has(fragment.approvalId);
      const currentClaim = activeByReport.get(fragment.reportId) ?? null;
      let invalidation = null;
      if (!stillApproved) {
        const revocation = this.revocations[fragment.approvalId] ?? null;
        invalidation = {
          reason: revocation
            ? `审批已撤销：${revocation.reason}`
            : '当前审批已不再有效',
          revokedAt: revocation?.at ?? null,
          currentApprovalId: currentClaim?.approvalId ?? null,
          currentApprovedSpan: currentClaim?.approvedSpan ?? null,
        };
      }
      return {
        ...fragment,
        stillApproved,
        invalidation,
        changedSincePublish: Boolean(invalidation),
      };
    });

    const changes = [];
    const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
    const currentFragmentIds = new Set(current.snapshot.fragments.map((fragment) => fragment.id));
    for (const fragment of fragments) {
      if (!currentFragmentIds.has(fragment.id)) {
        changes.push({
          type: 'removed',
          fragmentId: fragment.id,
          reportId: fragment.reportId,
          teamName: fragment.teamName,
          span: fragment.span,
          reason: fragment.invalidation?.reason ?? '当前版本不再包含该片段',
        });
      }
    }
    for (const fragment of current.snapshot.fragments) {
      if (!fragmentById.has(fragment.id)) {
        changes.push({
          type: 'added',
          fragmentId: fragment.id,
          reportId: fragment.reportId,
          teamName: fragment.teamName,
          span: fragment.span,
        });
      }
    }

    return {
      publication,
      isCurrent: publication.id === this.currentId,
      currentPublicationId: this.currentId,
      checkedAt: new Date().toISOString(),
      fragments,
      validFragments: fragments.filter((fragment) => fragment.stillApproved),
      invalidFragments: fragments.filter((fragment) => !fragment.stillApproved),
      changes,
      diff: {
        removed: changes.filter((change) => change.type === 'removed').length,
        added: changes.filter((change) => change.type === 'added').length,
      },
    };
  }

  listPublications() {
    return this.publications.map((publication) => ({
      id: publication.id,
      sequence: publication.sequence,
      createdAt: publication.createdAt,
      action: publication.action,
      note: publication.note,
      supersedes: publication.supersedes,
      isCurrent: publication.isCurrent,
      digest: publication.digest,
      fragmentCount: publication.snapshot.fragments.length,
      totalDays: publication.snapshot.stats.publishedDays,
      revokedApprovals: publication.revokedApprovals,
    }));
  }

  view() {
    return {
      scenario: {
        title: this.scenario.title,
        description: this.scenario.description,
        roads: this.scenario.roads,
        teams: this.scenario.teams,
        reports: this.scenario.reports,
      },
      priorityMode: this.priorityMode,
      current: this.current(),
      publications: this.listPublications(),
      revocations: Object.entries(this.revocations).map(([approvalId, revocation]) => ({
        approvalId,
        ...revocation,
      })),
      history: clone(this.history),
      revocableApprovals: this.revocableApprovals(),
      retryQueue: this.current()?.retryQueue ?? [],
    };
  }

  revocableApprovals() {
    const { claims } = collectClaims(this.scenario, this.revocations);
    const claimed = new Map(claims.map((claim) => [claim.approvalId, claim]));
    const result = [];
    for (const report of this.scenario.reports) {
      const effective = effectiveAttempt(report);
      if (!effective) continue;
      if (effective.outcome !== 'approved' && effective.outcome !== 'partial') continue;
      if (effective.status !== 'active') continue;
      if (this.revocations[effective.id]) continue;
      const claim = claimed.get(effective.id);
      if (!claim) continue;
      const road = this.scenario.roads.find((candidate) => candidate.id === report.roadId);
      const team = this.scenario.teams.find((candidate) => candidate.id === report.teamId);
      result.push({
        approvalId: effective.id,
        reportId: report.id,
        roadId: report.roadId,
        roadName: road?.name ?? report.roadId,
        teamId: report.teamId,
        teamName: team?.name ?? report.teamId,
        work: report.work,
        attempt: effective.attempt,
        outcome: effective.outcome,
        approvedSpan: effective.approvedSpan,
        decidedAt: effective.decidedAt,
      });
    }
    return result;
  }

  audit() {
    return {
      history: clone(this.history),
      publications: this.listPublications(),
      revocations: Object.entries(this.revocations).map(([approvalId, revocation]) => ({
        approvalId,
        ...revocation,
      })),
    };
  }
}

export { PRIORITY_MODES };
