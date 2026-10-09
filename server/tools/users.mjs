#!/usr/bin/env node
/**
 * User and membership administration for `IPB_AUTH=on` (C1/C2/C6). Talks
 * to `auth.js`'s store directly — no server needs to be running.
 *
 *   node server/tools/users.mjs add <name> [--admin] [--password-stdin]
 *   node server/tools/users.mjs list
 *   node server/tools/users.mjs passwd <name> [--password-stdin]
 *   node server/tools/users.mjs member <name> --cell <cell> --role <role>
 *   node server/tools/users.mjs unmember <name>
 *   node server/tools/users.mjs remove <name>
 *
 * `--password-stdin` reads the password from stdin's first line (for
 * scripting); otherwise the terminal prompts twice, without echo.
 */
import { CELLS, ROLES } from '../policy.ts';
import { openAuthStore } from '../auth.ts';

const MEMBERSHIP_ROLES = ROLES.filter((role) => role !== 'admin');

function usage() {
  process.stderr.write(`Usage:
  node server/tools/users.mjs add <name> [--admin] [--password-stdin]
  node server/tools/users.mjs list
  node server/tools/users.mjs passwd <name> [--password-stdin]
  node server/tools/users.mjs member <name> --cell <cell> --role <role>
  node server/tools/users.mjs unmember <name>
  node server/tools/users.mjs remove <name>

Cells: ${CELLS.join(', ')}
Membership roles: ${MEMBERSHIP_ROLES.join(', ')}
`);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Reads one line from the terminal with the typed characters hidden. */
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    const wasRaw = stdin.isTTY && stdin.isRaw;
    stdin.resume();
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          finish();
          return;
        }
        if (char === '\u0003') {
          finish();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    function finish() {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    }
    stdin.on('data', onData);
  });
}

async function readPassword(args) {
  if (hasFlag(args, '--password-stdin')) {
    const raw = await readStdin();
    return raw.split('\n')[0].trimEnd();
  }
  const first = await promptHidden('Password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) throw new Error('Passwords did not match.');
  return first;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const store = openAuthStore();
  try {
    if (command === 'add') {
      const [name] = rest;
      if (!name) {
        usage();
        process.exitCode = 1;
        return;
      }
      const admin = hasFlag(rest, '--admin');
      const password = await readPassword(rest);
      await store.createUser(name, password, { admin });
      process.stdout.write(`Created ${name}${admin ? ' (admin)' : ''}.\n`);
    } else if (command === 'list') {
      const users = store.listUsersDetailed();
      if (!users.length) {
        process.stdout.write('No users.\n');
        return;
      }
      for (const user of users) {
        const membership = user.cell ? `${user.cell}/${user.role}` : '-';
        process.stdout.write(
          `${user.name}\t${user.admin ? 'admin' : '-'}\t${membership}\t${user.created_at}\n`,
        );
      }
    } else if (command === 'passwd') {
      const [name] = rest;
      if (!name) {
        usage();
        process.exitCode = 1;
        return;
      }
      const password = await readPassword(rest);
      await store.setPassword(name, password);
      process.stdout.write(`Password updated for ${name} (sessions revoked).\n`);
    } else if (command === 'member') {
      const [name] = rest;
      const cell = flagValue(rest, '--cell');
      const role = flagValue(rest, '--role');
      if (!name || !cell || !role) {
        usage();
        process.exitCode = 1;
        return;
      }
      store.setMembership(name, { cell, role });
      process.stdout.write(`${name} is now ${cell}/${role} in the current exercise.\n`);
    } else if (command === 'unmember') {
      const [name] = rest;
      if (!name) {
        usage();
        process.exitCode = 1;
        return;
      }
      store.removeMembership(name);
      process.stdout.write(`${name} is no longer a member of the current exercise.\n`);
    } else if (command === 'remove') {
      const [name] = rest;
      if (!name) {
        usage();
        process.exitCode = 1;
        return;
      }
      store.removeUser(name);
      process.stdout.write(`Removed ${name} (sessions revoked).\n`);
    } else {
      usage();
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
