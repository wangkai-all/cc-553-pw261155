import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { AppError, MethodNotAllowedError, NotFoundError, ValidationError } from './errors.js';
import { loadScenarioFile } from './scenario.js';
import { PublicationStore } from './store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ValidationError('请求体超过 1MB 上限');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须为 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new ValidationError(`请求体不是合法 JSON 对象：${error.message}`);
  }
}

function matchRoute(pathname) {
  const routes = [
    { method: 'GET', pattern: /^\/api\/state$/, handler: 'state' },
    { method: 'POST', pattern: /^\/api\/import$/, handler: 'import' },
    { method: 'POST', pattern: /^\/api\/rebuild$/, handler: 'rebuild' },
    { method: 'POST', pattern: /^\/api\/revise$/, handler: 'revise' },
    { method: 'POST', pattern: /^\/api\/revoke$/, handler: 'revoke' },
    { method: 'GET', pattern: /^\/api\/publications$/, handler: 'publications' },
    { method: 'GET', pattern: /^\/api\/publications\/([^/]+)$/, handler: 'publication' },
    { method: 'GET', pattern: /^\/api\/publications\/([^/]+)\/inspect$/, handler: 'inspect' },
    { method: 'GET', pattern: /^\/api\/audit$/, handler: 'audit' },
  ];
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (match) {
      return { ...route, params: match.slice(1).map(decodeURIComponent) };
    }
  }
  return null;
}

async function serveStatic(publicDir, pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(publicDir, normalize(relative));
  if (target !== publicDir && !target.startsWith(`${publicDir}${sep}`)) {
    throw new NotFoundError('静态资源不存在');
  }
  let content;
  try {
    content = await readFile(target);
  } catch {
    throw new NotFoundError(`静态资源不存在：${pathname}`);
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': type,
    'content-length': content.length,
    'cache-control': 'no-store',
  });
  response.end(content);
}

export async function createApp({ scenarioPath, publicDir, priorityMode } = {}) {
  const baseDir = resolve(import.meta.dirname, '..');
  const resolvedScenario = scenarioPath ?? join(baseDir, 'data', 'demo-scenario.json');
  const resolvedPublic = publicDir ? resolve(publicDir) : join(baseDir, 'public');
  const scenario = await loadScenarioFile(resolvedScenario);

  let store = new PublicationStore(scenario, { priorityMode });

  const handlers = {
    state() {
      return { status: 200, body: store.view() };
    },
    async import(request) {
      const body = await readJsonBody(request);
      const { PRIORITY_MODES } = await import('./approvals.js');
      if (body.priorityMode !== undefined && !PRIORITY_MODES.includes(body.priorityMode)) {
        throw new ValidationError(`priorityMode 必须是 ${PRIORITY_MODES.join(' / ')}`);
      }
      const priority = body.priorityMode ?? store.priorityMode;
      let scenarioInput;
      let source;
      if (body.scenario != null) {
        scenarioInput = body.scenario;
        source = 'request-body';
      } else if (Array.isArray(body.roads) || Array.isArray(body.reports)) {
        // 允许只递交道路与申报的子集，班组自动沿用当前场景。
        scenarioInput = {
          title: body.title ?? store.scenario.title,
          description: body.description ?? store.scenario.description,
          teams: body.teams ?? store.scenario.teams,
          roads: body.roads ?? [],
          reports: body.reports ?? [],
        };
        source = 'request-body';
      } else {
        scenarioInput = await loadScenarioFile(resolvedScenario);
        source = 'built-in-demo';
      }
      const nextStore = new PublicationStore(scenarioInput, { priorityMode: priority });
      const publication = nextStore.current();
      store = nextStore;
      return {
        status: 201,
        body: {
          imported: true,
          source,
          publication,
          state: store.view(),
        },
      };
    },
    async rebuild(request) {
      const body = await readJsonBody(request);
      if (body.priorityMode !== undefined) {
        const { PRIORITY_MODES } = await import('./approvals.js');
        if (!PRIORITY_MODES.includes(body.priorityMode)) {
          throw new ValidationError(`priorityMode 必须是 ${PRIORITY_MODES.join(' / ')}`);
        }
        store.priorityMode = body.priorityMode;
      }
      const publication = store.rebuild(typeof body.note === 'string' ? body.note : undefined);
      return { status: 201, body: { publication, state: store.view() } };
    },
    async revise(request) {
      const body = await readJsonBody(request);
      let affectedRoadIds = null;
      if (body.roadIds != null) {
        if (!Array.isArray(body.roadIds) || body.roadIds.some((id) => typeof id !== 'string')) {
          throw new ValidationError('roadIds 必须是道路 id 字符串数组');
        }
        affectedRoadIds = body.roadIds;
      } else if (typeof body.roadId === 'string') {
        affectedRoadIds = [body.roadId];
      }
      const publication = store.revise(affectedRoadIds, typeof body.note === 'string' ? body.note : undefined);
      return { status: 201, body: { publication, state: store.view() } };
    },
    async revoke(request) {
      const body = await readJsonBody(request);
      if (typeof body.approvalId !== 'string' || body.approvalId.trim() === '') {
        throw new ValidationError('approvalId 必须是非空字符串');
      }
      const result = store.revoke(body.approvalId, { reason: body.reason, actor: body.actor });
      return { status: 201, body: { ...result, state: store.view() } };
    },
    publications() {
      return { status: 200, body: { publications: store.listPublications(), currentId: store.currentId } };
    },
    publication(_request, params) {
      return { status: 200, body: store.getPublication(params[0]) };
    },
    inspect(_request, params) {
      return { status: 200, body: store.inspectPublication(params[0]) };
    },
    audit() {
      return { status: 200, body: store.audit() };
    },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      const route = matchRoute(url.pathname);
      if (route) {
        if (route.method !== request.method) {
          throw new MethodNotAllowedError(request.method ?? 'GET', url.pathname);
        }
        const result = await handlers[route.handler](request, route.params);
        sendJson(response, result.status, result.body);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        throw new NotFoundError(`接口不存在：${url.pathname}`);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new MethodNotAllowedError(request.method ?? 'GET', url.pathname);
      }
      await serveStatic(resolvedPublic, url.pathname, response);
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
          details: null,
        },
      });
    }
  });

  return { server, get store() { return store; } };
}
