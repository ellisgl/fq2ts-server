// The database's layout, as the steps that build it. A database records how
// many steps it has had (SQLite's user_version), and opening it runs the
// rest, in order, each in a transaction: a step that fails changes nothing.
//
// To change the layout, add a step to the end. Never change or reorder a
// step that has been released: databases out there have already had it.

import type { Database } from 'bun:sqlite';

export interface Migration {
    // What the step does (for the log, and for whoever reads this).
    description: string;
    up(db: Database): void;
}

export const MIGRATIONS: readonly Migration[] = [
    {
        description: 'Accounts and their players',
        up: (db) => {
            // (IF NOT EXISTS: databases from before there were steps may
            // have some of these.)
            db.run(`
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_login TEXT
                );
                CREATE TABLE IF NOT EXISTS players (
                    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
                    state TEXT NOT NULL,
                    saved_at TEXT NOT NULL
                );
            `);
        },
    },
    {
        description: 'Email addresses, and the codes sent to them',
        up: (db) => {
            db.run(`
                ALTER TABLE accounts ADD COLUMN email TEXT;
                ALTER TABLE accounts ADD COLUMN email_confirmed INTEGER NOT NULL DEFAULT 0;
                CREATE TABLE codes (
                    account_id INTEGER NOT NULL REFERENCES accounts(id),
                    purpose TEXT NOT NULL,
                    code_hash TEXT NOT NULL,
                    sent_at INTEGER NOT NULL,
                    tries INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (account_id, purpose)
                );
            `);
        },
    },
    {
        description: 'One account per confirmed email address',
        up: (db) => {
            // Where accounts share one, the first to have confirmed it keeps it.
            db.run(`
                UPDATE accounts SET email_confirmed = 0 WHERE email_confirmed = 1 AND id NOT IN (
                    SELECT MIN(id) FROM accounts WHERE email_confirmed = 1 GROUP BY email COLLATE NOCASE
                );
                CREATE UNIQUE INDEX accounts_email ON accounts (email COLLATE NOCASE) WHERE email_confirmed = 1;
            `);
        },
    },
    {
        description: 'Letters between players, and the news',
        up: (db) => {
            db.run(`
                CREATE TABLE letters (
                    id INTEGER PRIMARY KEY,
                    account_id INTEGER NOT NULL REFERENCES accounts(id),
                    sender TEXT NOT NULL,
                    text TEXT NOT NULL,
                    sent_at INTEGER NOT NULL,
                    read INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX letters_account ON letters (account_id, sent_at);
                CREATE TABLE news (
                    id INTEGER PRIMARY KEY,
                    text TEXT NOT NULL,
                    at INTEGER NOT NULL
                );
                CREATE INDEX news_at ON news (at);
            `);
        },
    },
    {
        description: "The world's state, shared by everyone",
        up: (db) => {
            db.run('CREATE TABLE world (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
        },
    },
];

const version = (db: Database): number => {
    const row: unknown = db.query('PRAGMA user_version').get();
    return typeof row === 'object' && row !== null && 'user_version' in row && typeof row.user_version === 'number' ? row.user_version : 0;
};

// Databases from before there were steps (user_version 0, but with tables
// in them): how many of the steps they already have, by what's there. (The
// first step is safe to run again.)
function before(db: Database): number {
    const has = (type: string, name: string): boolean => db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== null;
    if (has('index', 'accounts_email')) {
        return 3;
    }

    return has('table', 'codes') ? 2 : 0;
}

// Brings the database up to date; returns the descriptions of the steps
// run. Throws if the database is newer than this server (made by a later
// version), rather than use it.
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): string[] {
    let at = version(db);
    if (at === 0) {
        at = before(db);
        db.run(`PRAGMA user_version = ${at}`);
    }

    if (at > migrations.length) {
        throw new Error(`The database is from a newer version of the server (layout ${at}; this one knows up to ${migrations.length}).`);
    }

    const ran: string[] = [];
    for (const [i, step] of migrations.entries()) {
        if (i < at) {
            continue;
        }

        db.transaction(() => {
            step.up(db);
            // (PRAGMA takes no parameters; `i` is a number.)
            db.run(`PRAGMA user_version = ${i + 1}`);
        })();
        ran.push(step.description);
    }

    return ran;
}
