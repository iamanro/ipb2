/**
 * The password-change screen (C3, admin role): shown full-screen and
 * un-cancellable right after a sign-in with `must_change_password` set
 * (first-admin bootstrap, or an admin's reset-password), and on demand from
 * the masthead user chip's "Change password" button otherwise. Renders into
 * the shell's `#module-root`, the same slot a module or the login screen
 * fills — `src/login.js` is the sibling for the sign-in form itself.
 */
const PASSWORD_MIN_LENGTH = 12;

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * `onSuccess({ name, role })` fires after a successful `POST
 * /api/auth/password`. `forced` (must-change-password) hides the cancel
 * button; otherwise `onCancel()` returns to whatever the user was doing.
 */
export function renderChangePasswordScreen(root, { forced, onSuccess, onCancel }) {
  const screen = createElement('div', 'login-screen');
  const card = document.createElement('form');
  card.className = 'login-card';
  card.noValidate = true;

  card.append(
    createElement(
      'p',
      'login-eyebrow eyebrow',
      forced ? 'Password change required' : 'Change password',
    ),
    createElement('h1', 'login-title', 'AGILE CUB'),
    createElement(
      'p',
      'login-subtitle',
      forced
        ? 'This account was given a temporary password. Choose your own before continuing.'
        : 'Choose a new password. Your other sessions will be signed out.',
    ),
  );

  const currentField = createElement('label', 'login-field');
  const currentInput = document.createElement('input');
  currentInput.type = 'password';
  currentInput.name = 'current';
  currentInput.autocomplete = 'current-password';
  currentInput.required = true;
  currentField.append(createElement('span', null, 'Current password'), currentInput);

  const nextField = createElement('label', 'login-field');
  const nextInput = document.createElement('input');
  nextInput.type = 'password';
  nextInput.name = 'next';
  nextInput.autocomplete = 'new-password';
  nextInput.required = true;
  nextInput.minLength = PASSWORD_MIN_LENGTH;
  nextField.append(
    createElement('span', null, `New password (at least ${PASSWORD_MIN_LENGTH} characters)`),
    nextInput,
  );

  const confirmField = createElement('label', 'login-field');
  const confirmInput = document.createElement('input');
  confirmInput.type = 'password';
  confirmInput.name = 'confirm';
  confirmInput.autocomplete = 'new-password';
  confirmInput.required = true;
  confirmField.append(createElement('span', null, 'Confirm new password'), confirmInput);

  const error = createElement('p', 'login-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const submit = createElement('button', 'login-submit', 'Change password');
  submit.type = 'submit';

  card.append(currentField, nextField, confirmField, error, submit);

  if (!forced) {
    const cancel = createElement('button', 'login-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => onCancel?.());
    card.append(cancel);
  }

  screen.append(card);
  root.replaceChildren(screen);
  currentInput.focus();

  card.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (nextInput.value !== confirmInput.value) {
      error.textContent = 'New password and confirmation do not match.';
      error.hidden = false;
      confirmInput.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Changing…';
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: currentInput.value, next: nextInput.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload.error || `Could not change password (${response.status}).`);
      currentInput.value = '';
      nextInput.value = '';
      confirmInput.value = '';
      onSuccess(payload.user);
    } catch (caught) {
      error.textContent = caught.message;
      error.hidden = false;
      currentInput.value = '';
      currentInput.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Change password';
    }
  });

  return () => {
    screen.remove();
  };
}
