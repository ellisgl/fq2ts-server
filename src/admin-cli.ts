// The admin command line, for the server's database (it can run while the
// server does): list the accounts, make admins, ban and unban. A game's
// own admin script calls runAdmin with its database's name.
//
//   bun run admin list
//   bun run admin admin NAME           (the first admin is made this way)
//   bun run admin ban NAME REASON...
//
// A ban stops the player coming in; someone in the realm now stays until
// they leave, unless an admin kicks them from the game (!).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store, type Account } from './store.ts';

const usage = (prefix: string): string => `Usage: admin COMMAND [NAME] [REASON...] [--data DIR]

  list                   every account: name, email, admin or banned
  admin NAME             make NAME an admin (the ! key in the game)
  unadmin NAME           take it away again
  ban NAME REASON...     ban NAME; they're told the reason when they try
                         to come in
  unban NAME             lift the ban

  --data DIR             where the server's database is (default:
                         ${prefix}DATA, else server-data)
  -h, --help             show this help`;

export interface AdminCli {
    // The database's file name, in the data folder (as runServer's).
    database?: string;
    args?: readonly string[];
    envPrefix?: string;
    log?(line: string): void;
    error?(line: string): void;
}

// Runs one command; the exit code.
export function runAdmin({ database = 'game.sqlite', args = process.argv.slice(2), envPrefix = 'FQ2_', log = console.log, error = console.error }: AdminCli = {}): number {
    const { values, positionals } = parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
            data: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    const [command, name, ...reason] = positionals;
    if (values.help || command === undefined) {
        log(usage(envPrefix));
        return values.help ? 0 : 1;
    }

    const file = join(resolve(values.data ?? process.env[`${envPrefix}DATA`] ?? 'server-data'), database);
    if (!existsSync(file)) {
        error(`There's no database at ${file}. (Start the server once, or give --data.)`);
        return 1;
    }

    const store = new Store(file);
    try {
        if (command === 'list') {
            for (const account of store.accounts()) {
                log(describe(account));
            }
            return 0;
        }

        if (!['admin', 'unadmin', 'ban', 'unban'].includes(command)) {
            error(`There's no command "${command}". (-h lists them.)`);
            return 1;
        }

        const account = name === undefined ? null : store.account(name);
        if (!account) {
            error(name === undefined ? `${command} needs a name.` : `There's no account called "${name}".`);
            return 1;
        }

        if (command === 'admin' || command === 'unadmin') {
            store.setAdmin(account.id, command === 'admin');
            log(command === 'admin' ? `${account.name} is an admin.` : `${account.name} isn't an admin now.`);
        } else if (command === 'ban') {
            const why = reason.join(' ').trim();
            if (!why) {
                error('A ban needs a reason (the player is told it).');
                return 1;
            }
            store.setBanned(account.id, why);
            log(`${account.name} is banned: ${why}`);
        } else {
            store.setBanned(account.id, null);
            log(`${account.name} isn't banned now.`);
        }
        return 0;
    } finally {
        store.close();
    }
}

function describe({ name, email, emailConfirmed, admin, banned }: Account): string {
    const parts = [name.padEnd(22), (email ?? '-').padEnd(32), emailConfirmed ? 'confirmed' : 'unconfirmed'];
    if (admin) {
        parts.push('admin');
    }
    if (banned !== null) {
        parts.push(`banned: ${banned}`);
    }
    return parts.join('  ').trimEnd();
}
