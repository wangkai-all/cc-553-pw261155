import { assertPriorityMode } from './approvals.js';
import { dayCount, subtractIntervals } from './intervals.js';

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function priorityComparator(mode) {
  if (mode === 'latest-approval') {
    // 后获批者优先：decidedAt 越晚越先占用。
    return (left, right) =>
      compareStrings(right.decidedAt, left.decidedAt)
      || compareStrings(left.submittedAt, right.submittedAt)
      || compareStrings(left.reportId, right.reportId);
  }
  // 先申报者优先：submittedAt 越早越先占用。
  return (left, right) =>
    compareStrings(left.submittedAt, right.submittedAt)
    || compareStrings(left.decidedAt, right.decidedAt)
    || compareStrings(left.reportId, right.reportId);
}

function toExclusion(claim, state, reason, extra = {}) {
  return {
    reportId: claim.reportId,
    approvalId: claim.approvalId ?? null,
    attempt: claim.attempt ?? null,
    roadId: claim.roadId,
    roadCode: claim.roadCode,
    teamId: claim.teamId,
    teamName: claim.teamName,
    work: claim.work,
    originalSpan: claim.originalSpan,
    approvedSpan: claim.approvedSpan ?? null,
    state,
    reason,
    ...extra,
  };
}

/**
 * 单条道路的裁决：按确定性优先级依次占用，后来者只能拿到尚未占用的子区间。
 * 同日相接由 subtractIntervals 的半开语义天然处理，不会切出零长度片段。
 */
export function adjudicateRoad(road, claims, exclusionsIn, priorityMode) {
  const ordered = [...claims]
    .filter((claim) => claim.roadId === road.id)
    .sort(priorityComparator(priorityMode));

  const fragments = [];
  const exclusions = exclusionsIn.filter((item) => item.roadId === road.id);
  const occupancy = [];

  for (const claim of ordered) {
    const blockers = occupancy.filter(
      (block) => claim.approvedSpan.start < block.span.end && block.span.start < claim.approvedSpan.end,
    );
    const granted = subtractIntervals(claim.approvedSpan, blockers.map((block) => block.span));

    if (granted.length === 0) {
      exclusions.push(
        toExclusion(
          claim,
          'fully-overlapped',
          '审批有效的区间已被更高优先级的班组全部占用，无可公示片段',
          {
            blockedBy: blockers.map((block) => ({
              reportId: block.reportId,
              teamName: block.teamName,
              span: block.span,
            })),
          },
        ),
      );
      continue;
    }

    const lost = subtractIntervals(claim.approvedSpan, granted);
    granted.forEach((span, index) => {
      fragments.push({
        id: `${claim.reportId}#${index + 1}`,
        reportId: claim.reportId,
        approvalId: claim.approvalId,
        attempt: claim.attempt,
        outcome: claim.outcome,
        roadId: road.id,
        roadCode: road.code,
        roadName: road.name,
        teamId: claim.teamId,
        teamName: claim.teamName,
        work: claim.work,
        span,
        days: dayCount(span),
        originalSpan: claim.originalSpan,
        approvedSpan: claim.approvedSpan,
        trimmed: lost.length > 0,
        lost,
        blockedBy: blockers.map((block) => ({
          reportId: block.reportId,
          teamName: block.teamName,
          span: block.span,
        })),
      });
    });

    if (lost.length > 0) {
      exclusions.push(
        toExclusion(claim, 'partially-overlapped', '与更高优先级班组交叠，已切分后发布剩余片段', {
          lost,
          publishedFragments: granted.length,
        }),
      );
    }

    // 只有真正发布的片段才占用道路；被完全挤掉的审批不应阻挡后续班组。
    for (const span of granted) {
      occupancy.push({
        reportId: claim.reportId,
        teamName: claim.teamName,
        span,
      });
    }
  }

  fragments.sort((left, right) => compareStrings(left.span.start, right.span.start) || compareStrings(left.id, right.id));
  return { fragments, exclusions };
}

function summarize(fragments, exclusions) {
  const byRoad = new Map();
  for (const fragment of fragments) {
    const entry = byRoad.get(fragment.roadId) ?? { fragments: 0, days: 0 };
    entry.fragments += 1;
    entry.days += fragment.days;
    byRoad.set(fragment.roadId, entry);
  }
  return {
    publishedFragments: fragments.length,
    publishedDays: fragments.reduce((sum, fragment) => sum + fragment.days, 0),
    roadsWithWork: byRoad.size,
    trimmedClaims: exclusions.filter((item) => item.state === 'partially-overlapped').length,
    fullyOverlapped: exclusions.filter((item) => item.state === 'fully-overlapped').length,
    notPublished: exclusions.filter(
      (item) => !['partially-overlapped', 'fully-overlapped'].includes(item.state),
    ).length,
  };
}

function assemble(roads, priorityMode, extra = {}) {
  const fragments = roads.flatMap((road) => road.fragments);
  const exclusions = roads.flatMap((road) => road.exclusions);
  return {
    generatedAt: new Date().toISOString(),
    priorityMode,
    roads,
    fragments,
    exclusions,
    stats: summarize(fragments, exclusions),
    ...extra,
  };
}

export function adjudicate(scenario, { claims, exclusions, priorityMode = 'first-submitted' }) {
  assertPriorityMode(priorityMode);
  const roads = scenario.roads.map((road) => {
    const result = adjudicateRoad(road, claims, exclusions, priorityMode);
    return {
      roadId: road.id,
      code: road.code,
      name: road.name,
      fragments: result.fragments,
      exclusions: result.exclusions,
    };
  });
  return assemble(roads, priorityMode);
}

/**
 * 逐段修订：只重算受影响的道路，其余道路沿用上一版结果。
 * 由于裁决道路之间彼此独立，结果必须与全量重建逐字节一致（见测试）。
 */
export function reviseAdjudication(previous, scenario, { claims, exclusions, priorityMode = 'first-submitted' }, affectedRoadIds) {
  assertPriorityMode(priorityMode);
  const affected = new Set(affectedRoadIds ?? scenario.roads.map((road) => road.id));
  const previousByRoad = new Map((previous?.roads ?? []).map((road) => [road.roadId, road]));

  const roads = scenario.roads.map((road) => {
    if (affected.has(road.id) || !previousByRoad.has(road.id)) {
      const result = adjudicateRoad(road, claims, exclusions, priorityMode);
      return {
        roadId: road.id,
        code: road.code,
        name: road.name,
        fragments: result.fragments,
        exclusions: result.exclusions,
      };
    }
    return previousByRoad.get(road.id);
  });

  return assemble(roads, priorityMode, {
    revision: {
      strategy: 'incremental',
      recomputedRoads: roads.filter((road) => affected.has(road.roadId)).map((road) => road.roadId),
      carriedRoads: roads.filter((road) => !affected.has(road.roadId)).map((road) => road.roadId),
    },
  });
}

export function coreProjection(adjudication) {
  return {
    priorityMode: adjudication.priorityMode,
    roads: adjudication.roads,
    fragments: adjudication.fragments,
    exclusions: adjudication.exclusions,
    stats: adjudication.stats,
  };
}
