/**
 * The sign-in screen shown in place of a module when `IPB_AUTH=on` and no
 * session cookie is set (`src/session.js`). Renders into the shell's
 * `#module-root`, the same slot a module fills.
 */
const NAME_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$';

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `onSuccess({ name, role })` fires after a successful `POST /api/auth/login`. */
export function renderLoginScreen(root, { onSuccess }) {
  const screen = createElement('div', 'login-screen');
  const card = document.createElement('form');
  card.className = 'login-card';
  card.noValidate = true;

  card.append(
    createElement('p', 'login-eyebrow eyebrow', 'Sign-in required'),
    createElement('h1', 'login-title', 'AGILE CUB'),
    createElement(
      'p',
      'login-subtitle',
      'This instance is reachable over the network. Sign in to continue.',
    ),
  );

  const nameField = createElement('label', 'login-field');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.name = 'name';
  nameInput.autocomplete = 'username';
  nameInput.required = true;
  nameInput.pattern = NAME_PATTERN;
  nameField.append(createElement('span', null, 'Name'), nameInput);

  const passwordField = createElement('label', 'login-field');
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.name = 'password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.required = true;
  passwordField.append(createElement('span', null, 'Password'), passwordInput);

  const error = createElement('p', 'login-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const submit = createElement('button', 'login-submit', 'Sign in');
  submit.type = 'submit';

  card.append(nameField, passwordField, error, submit);
  screen.append(card);
  root.replaceChildren(screen);
  nameInput.focus();

  card.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, password: passwordInput.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Sign-in failed (${response.status}).`);
      passwordInput.value = '';
      onSuccess(payload.user);
    } catch (caught) {
      error.textContent = caught.message;
      error.hidden = false;
      passwordInput.value = '';
      passwordInput.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  return () => {
    screen.remove();
  };
}
