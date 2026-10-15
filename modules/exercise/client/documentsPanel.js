// Exercise: the Documents panel — scenario documents (OPLAN, annexes, plans)
// a cell uploads, releases to other cells, and replaces with a new edition.

import { canEditClient, renderReleaseControl } from '../../../src/release.js';
import { can } from '../../../src/session.js';
import { appendOwnerReassign } from './ownerReassign.js';

import {
  API,
  askConfirm,
  askText,
  createElement,
  elements,
  formatDate,
  hasCell,
  loadAll,
  readFileBase64,
  renderPanel,
  requestJson,
  showError,
  state,
} from './view.js';

/** Mirrors the server's MAX_DOCUMENT_BYTES, so an oversized file fails before upload. */
const MAX_BYTES = 25 << 20;

function formatSize(bytes) {
  return bytes < 1 << 20
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** The fields a file sets on create or replace. */
async function fileBody(file) {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 25 MB.`);
  return {
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    data: await readFileBase64(file),
  };
}

async function refresh(work, container) {
  try {
    await work();
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

/** A hidden file input opened by a button; `onFile` gets the chosen file. */
function fileButton(label, className, onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  input.addEventListener('change', () => {
    const [file] = input.files;
    input.value = '';
    if (file) onFile(file);
  });
  const button = createElement('button', className, label);
  button.type = 'button';
  button.addEventListener('click', () => input.click());
  return [button, input];
}

function renderUpload(container) {
  const section = createElement('section', 'field-group');
  section.append(
    createElement('h3', null, 'Add document'),
    createElement(
      'p',
      'panel-note',
      'Only your cell sees a new document until you release it. Replace it with a new edition at any time: the release stays.',
    ),
  );
  const form = createElement('div', 'requirement-form');
  const title = document.createElement('input');
  title.type = 'text';
  title.placeholder = 'Title (defaults to the file name)';
  title.setAttribute('aria-label', 'Document title');
  const [button, input] = fileButton('Choose file and upload…', 'primary-button', (file) =>
    refresh(async () => {
      await requestJson(`${API}/documents`, {
        method: 'POST',
        body: { title: title.value.trim(), ...(await fileBody(file)) },
      });
    }, section),
  );
  form.append(title, button, input);
  section.append(form);
  container.append(section);
}

function renderDocumentRow(doc) {
  const row = createElement('div', 'document-row');
  const header = createElement('div', 'rfi-header');
  const link = createElement('a', 'document-title', doc.title);
  link.href = `${API}/documents/${doc.id}/file`;
  link.target = '_blank';
  link.rel = 'noopener';
  header.append(
    link,
    createElement(
      'span',
      'panel-note',
      `${doc.filename} · ${formatSize(doc.size)} · edition ${doc.version} · ${formatDate(doc.updated_at)}`,
    ),
  );
  if (can('analyst') && canEditClient(doc)) {
    const [replace, input] = fileButton('New edition…', 'icon-button', (file) =>
      refresh(async () => {
        if (!(await askConfirm(`Replace “${doc.title}” with ${file.name}?`, 'Replace'))) return;
        await requestJson(`${API}/documents/${doc.id}`, {
          method: 'PATCH',
          body: await fileBody(file),
        });
      }, row),
    );
    const rename = createElement('button', 'icon-button', 'Rename');
    rename.type = 'button';
    rename.addEventListener('click', async () => {
      const title = await askText('Document title', doc.title);
      if (!title?.trim()) return;
      await refresh(
        () =>
          requestJson(`${API}/documents/${doc.id}`, {
            method: 'PATCH',
            body: { title: title.trim() },
          }),
        row,
      );
    });
    const remove = createElement('button', 'icon-button danger', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!(await askConfirm(`Delete “${doc.title}”?`))) return;
      await refresh(() => requestJson(`${API}/documents/${doc.id}`, { method: 'DELETE' }), row);
    });
    header.append(replace, input, rename, remove);
  }
  row.append(header);
  row.append(
    renderReleaseControl({
      item: doc,
      onRelease: (cells) =>
        refresh(
          () =>
            requestJson(`${API}/documents/${doc.id}/release`, {
              method: 'POST',
              body: { cells },
            }),
          row,
        ),
    }),
  );
  appendOwnerReassign(row, doc.owner_cell, (cell) =>
    refresh(
      () =>
        requestJson(`${API}/documents/${doc.id}/owner`, {
          method: 'PATCH',
          body: { owner_cell: cell },
        }),
      row,
    ),
  );
  return row;
}

export function renderDocumentsPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Documents — OPLAN, annexes, plans'));
  if (can('analyst') && hasCell()) renderUpload(container);
  if (!state.documents.length) {
    container.append(createElement('p', 'panel-note', 'No documents for your cell yet.'));
    return;
  }
  const list = createElement('div', 'rfi-list');
  state.documents.forEach((doc) => list.append(renderDocumentRow(doc)));
  container.append(list);
}
