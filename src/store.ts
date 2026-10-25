// The server's database (SQLite): accounts and their players.
//
// An account is a name, a password hash and an email address (for
// resetting the password, once it's been confirmed); the name is also the
// player's name in the game. A confirmed address belongs to one account
// only. (Unconfirmed ones can be shared, so no one can hold on to someone
// else's address by signing up with it and never confirming it.) A player is saved as JSON (the same shape as
// a save slot's state), and checked with restorePlayer when it's loaded.

import { Database } from 'bun:sqlite';
import { field, integer, oneOf, record, string } from '../engine/validate.ts';
import type { CodePurpose } from './mail.ts';

export interface Account {
    id: number;
    name: string;
    passwordHash: string;
    // null for accounts made before there were email addresses.
    email: string | null;
    emailConfirmed: boolean;
}

// How long a code works, and how many guesses it gets.
export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;

export type CodeCheck = 'right' | 'wrong' | 'none';

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
                last_login TEXT,
                email TEXT,
                email_confirmed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS players (
                account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
                state TEXT NOT NULL,
                saved_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS codes (
                account_id INTEGER NOT NULL REFERENCES accounts(id),
                purpose TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                sent_at INTEGER NOT NULL,
                tries INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, purpose)
            );
        `);
        // Databases from before email addresses.
        const columns: unknown = this.db.query('SELECT name FROM pragma_table_info(\'accounts\')').all();
        const names = Array.isArray(columns) ? columns.map((c) => field(record(c, 'column'), 'name', 'column', string)) : [];
        if (!names.includes('email')) {
            this.db.run('ALTER TABLE accounts ADD COLUMN email TEXT');
            this.db.run('ALTER TABLE accounts ADD COLUMN email_confirmed INTEGER NOT NULL DEFAULT 0');
        }

        if (this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'accounts_email'").get() === null) {
            // Databases from before addresses were unique: the first account
            // to have confirmed one keeps it.
            this.db.run(`
                UPDATE accounts SET email_confirmed = 0 WHERE email_confirmed = 1 AND id NOT IN (
                    SELECT MIN(id) FROM accounts WHERE email_confirmed = 1 GROUP BY email COLLATE NOCASE
                )
            `);
            this.db.run('CREATE UNIQUE INDEX accounts_email ON accounts (email COLLATE NOCASE) WHERE email_confirmed = 1');
        }
    }

    public close(): void {
        this.db.close();
    }

    // A new account, or null if the name is taken (in any case).
    // Its email address still needs confirming.
    public createAccount(name: string, passwordHash: string, email: string): Account | null {
        if (this.account(name)) {
            return null;
        }

        this.db.query('INSERT INTO accounts (name, password_hash, email, created_at) VALUES ($name, $hash, $email, $now)').run({ name, hash: passwordHash, email, now: now() });
        return this.account(name);
    }

    // The account with this name (in any case), if there is one.
    public account(name: string): Account | null {
        const row: unknown = this.db.query('SELECT id, name, password_hash, email, email_confirmed FROM accounts WHERE name = $name').get({ name });
        if (row === null) {
            return null;
        }

        const r = record(row, 'account');
        const email = r['email'];
        return {
            id: field(r, 'id', 'account', integer),
            name: field(r, 'name', 'account', string),
            passwordHash: field(r, 'password_hash', 'account', string),
            email: email === null ? null : field(r, 'email', 'account', string),
            emailConfirmed: field(r, 'email_confirmed', 'account', oneOf([0, 1])) === 1,
        };
    }

    // A new address, which needs confirming (a code sent to the old one
    // won't do).
    public setEmail(accountId: number, email: string): void {
        this.db.query('UPDATE accounts SET email = $email, email_confirmed = 0 WHERE id = $id').run({ id: accountId, email });
        this.deleteCode(accountId, 'confirm');
    }

    // Whether another account has confirmed this address (in any case).
    public emailInUse(email: string, exceptAccountId = 0): boolean {
        return this.db.query('SELECT 1 FROM accounts WHERE email = $email COLLATE NOCASE AND email_confirmed = 1 AND id != $id').get({ email, id: exceptAccountId }) !== null;
    }

    // Confirms the account's address; false if another account confirmed
    // it first.
    public confirmEmail(accountId: number): boolean {
        const account: unknown = this.db.query('SELECT email FROM accounts WHERE id = $id').get({ id: accountId });
        const email = account === null ? null : record(account, 'account')['email'];
        if (typeof email !== 'string' || this.emailInUse(email, accountId)) {
            return false;
        }

        this.db.query('UPDATE accounts SET email_confirmed = 1 WHERE id = $id').run({ id: accountId });
        return true;
    }

    // Swaps a confirmed address for another, already confirmed (by a
    // code sent to it); false if another account has it.
    public changeEmail(accountId: number, email: string): boolean {
        if (this.emailInUse(email, accountId)) {
            return false;
        }

        this.db.query('UPDATE accounts SET email = $email, email_confirmed = 1 WHERE id = $id').run({ id: accountId, email });
        this.deleteCode(accountId, 'change');
        return true;
    }

    public setPassword(accountId: number, passwordHash: string): void {
        this.db.query('UPDATE accounts SET password_hash = $hash WHERE id = $id').run({ id: accountId, hash: passwordHash });
    }

    // ---- Codes sent by email (only their hashes are kept)

    // A new code for this, in place of any before it.
    public saveCode(accountId: number, purpose: CodePurpose, codeHash: string, sentAt: number): void {
        this.db
            .query('INSERT INTO codes (account_id, purpose, code_hash, sent_at) VALUES ($id, $purpose, $hash, $at) ON CONFLICT(account_id, purpose) DO UPDATE SET code_hash = $hash, sent_at = $at, tries = 0')
            .run({ id: accountId, purpose, hash: codeHash, at: sentAt });
    }

    public deleteCode(accountId: number, purpose: CodePurpose): void {
        this.db.query('DELETE FROM codes WHERE account_id = $id AND purpose = $purpose').run({ id: accountId, purpose });
    }

    // When the last code for this was sent, if it's still there.
    public codeSentAt(accountId: number, purpose: CodePurpose): number | null {
        const row: unknown = this.db.query('SELECT sent_at FROM codes WHERE account_id = $id AND purpose = $purpose').get({ id: accountId, purpose });
        return row === null ? null : field(record(row, 'code'), 'sent_at', 'code', integer);
    }

    // Checks a code. A right one is used up; so is one that's expired or
    // been guessed at too often ('none': there's no code to check).
    public checkCode(accountId: number, purpose: CodePurpose, codeHash: string, at: number): CodeCheck {
        const key = { id: accountId, purpose };
        const row: unknown = this.db.query('SELECT code_hash, sent_at, tries FROM codes WHERE account_id = $id AND purpose = $purpose').get(key);
        if (row === null) {
            return 'none';
        }

        const r = record(row, 'code');
        const expired = at - field(r, 'sent_at', 'code', integer) > CODE_MINUTES * 60_000;
        if (expired || field(r, 'tries', 'code', integer) >= CODE_TRIES) {
            this.deleteCode(accountId, purpose);
            return 'none';
        }

        if (field(r, 'code_hash', 'code', string) === codeHash) {
            this.deleteCode(accountId, purpose);
            return 'right';
        }

        this.db.query('UPDATE codes SET tries = tries + 1 WHERE account_id = $id AND purpose = $purpose').run(key);
        return 'wrong';
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
