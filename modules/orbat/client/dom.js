import { clientId } from '../../../src/live.js';
import { handleUnauthorized } from '../../../src/session.js';

export const API = '/api/orbat';

export function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** JSON request against the module API; throws the server's error message. */
export async function requestJson(path, { method = 'GET', body, signal } = {}) {
  const options = { method, signal, headers: { 'X-Client-Id': clientId } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

/** Save `content` as a file through a temporary link. */
export function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** A file name from free text: letters, digits and dashes only. */
export function fileSlug(text, fallback = 'orbat') {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  return slug || fallback;
}
