import { HttpError, sendJson } from './http.js';
import { modules } from './modules.js';

const byId = new Map(modules.map((module) => [module.id, module]));

async function dispatch(request, response, next) {
  const url = new URL(request.url, 'http://localhost');
  const match = /^\/api\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return next();
  try {
    const module = byId.get(match[1]);
    if (!module) throw new HttpError(404, 'Unknown module.');
    await module.handle({ route: match[2], url, request, response });
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(response, { error: error.message }, status);
  }
}

export default function ipbApi() {
  const attach = (server) => {
    server.middlewares.use(dispatch);
    server.httpServer?.once('close', () => {
      for (const module of modules) module.close();
    });
  };
  return {
    name: 'ipb-api',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
