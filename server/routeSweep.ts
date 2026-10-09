import { HttpError } from './http.ts';

/**
 * The per-module guard ADR 0002 relies on, generated from the route table so
 * a new route is swept the day it's added: every route that names an item,
 * called as a member of another cell, must answer 404 on an item hidden from
 * that cell, and 403 (except plain reads) on one merely released to it.
 * Returns a list of failures (empty when the module holds the line).
 *
 *   sweepRoutes({
 *     dispatcher, moduleId, actor,                  // e.g. a Blue analyst
 *     fixtures: {
 *       <item kind>: {
 *         hidden:   { item: id, parts: { <part kind>: id } },   // owned by another cell, not released
 *         released: { item: id, parts: { <part kind>: id } },   // owned by another cell, released to actor
 *       },
 *     },
 *     params: { <other :param>: value },           // e.g. { format: 'geojson' }
 *   })
 */
export async function sweepRoutes({ dispatcher, moduleId, actor, fixtures, params = {} }) {
  const failures: string[] = [];
  const routes = dispatcher
    .describe()
    .filter((route) => route.module === moduleId && route.item && route.verb !== 'create');
  for (const route of routes) {
    const fixture = fixtures[route.item];
    if (!fixture) {
      failures.push(`${route.method} ${route.path}: no fixture for item kind "${route.item}"`);
      continue;
    }
    const cases: [string, number][] = [['hidden', 404]];
    if (route.method !== 'GET' && route.method !== 'HEAD') cases.push(['released', 403]);
    for (const [variant, expected] of cases) {
      const target = fixture[variant];
      const path = String(route.path)
        .split('/')
        .map((segment) => {
          if (segment === ':item') return String(target.item);
          if (segment === ':part')
            return String(target.parts?.[route.part] ?? 'missing-part-fixture');
          if (segment.startsWith(':')) return String(params[segment.slice(1)] ?? '1');
          return segment;
        })
        .join('/');
      let status = 200;
      try {
        await dispatcher.runAs(actor, moduleId, route.method, path, {});
      } catch (error) {
        status = error instanceof HttpError ? error.status : 500;
      }
      if (status !== expected)
        failures.push(`${route.method} ${path} (${variant}): ${status}, expected ${expected}`);
    }
  }
  return failures;
}
