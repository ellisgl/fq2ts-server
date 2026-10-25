// The server's database (SQLite): accounts and their players.
//
// An account is a name and a password hash; the name is also the
// player's name in the game. A player is saved as JSON (the same shape as
// a save slot's state), and checked with restorePlayer when it's loaded.

import { Database } from 'bun:sqlite';
import { field, integer, record, string } from '../engine/validate.ts';

export interface Account {
    id: number;
    name: string;
    passwordHash: string;
}

// Names: 2 to 20 letters, digits, spaces and ' - . (starting with a letter
// or digit). They're shown to other players, so nothing that could be markup.
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '.-]{1,19}$/;

export function validName(name: string): boolean {
    return NAME_PATTERN.test(name) && !name.includes('  ') && name === name.trim();
}

export class Store {
    private readonly db: Database;

    // `path` is a file, or ':memory:' for a database that's thrown away.
    public constructor(path: string) {
        this.db = new Database(path, { create: true, strict: true });
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run(`
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
    }

    public close(): void {
        this.db.close();
    }

    // A new account, or null if the name is taken (in any case).
    public createAccount(name: string, passwordHash: string): Account | null {
        if (this.account(name)) {
            return null;
        }

        this.db.query('INSERT INTO accounts (name, password_hash, created_at) VALUES ($name, $hash, $now)').run({ name, hash: passwordHash, now: now() });
        return this.account(name);
    }

    // The account with this name (in any case), if there is one.
    public account(name: string): Account | null {
        const row: unknown = this.db.query('SELECT id, name, password_hash FROM accounts WHERE name = $name').get({ name });
        if (row === null) {
            return null;
        }

        const r = record(row, 'account');
        return { id: field(r, 'id', 'account', integer), name: field(r, 'name', 'account', string), passwordHash: field(r, 'password_hash', 'account', string) };
    }

    public noteLogin(accountId: number): void {
        this.db.query('UPDATE accounts SET last_login = $now WHERE id = $id').run({ id: accountId, now: now() });
    }

    // The account's saved player (unchecked), or null if they haven't played.
    public loadPlayer(accountId: number): unknown {
        const row: unknown = this.db.query('SELECT state FROM players WHERE account_id = $id').get({ id: accountId });
        if (row === null) {
            return null;
        }

        const state: unknown = JSON.parse(field(record(row, 'player'), 'state', 'player', string));
        return state;
    }

    public savePlayer(accountId: number, player: unknown): void {
        this.db
            .query('INSERT INTO players (account_id, state, saved_at) VALUES ($id, $state, $now) ON CONFLICT(account_id) DO UPDATE SET state = $state, saved_at = $now')
            .run({ id: accountId, state: JSON.stringify(player), now: now() });
    }
}

const now = (): string => new Date().toISOString();
