// The server's database (SQLite): accounts and their players.
//
// An account is a name, a password hash and an email address (for
// resetting the password, once it's been confirmed); the name is also the
// player's name in the game. A confirmed address belongs to one account
// only. (Unconfirmed ones can be shared, so no one can hold on to someone
// else's address by signing up with it and never confirming it.)
//
// A player is saved as JSON (the same shape as a save slot's state), and
// checked with restorePlayer when it's loaded.

import { Database } from 'bun:sqlite';
import { field, integer, oneOf, record, string } from '@fq2js/engine/validate';
import type { CodePurpose } from './mail.ts';
import { migrate } from './migrations.ts';

export interface Account {
    id: number;
    name: string;
    passwordHash: string;
    // null for accounts made before there were email addresses.
    email: string | null;
    emailConfirmed: boolean;
    // Admins can kick and ban players (the ! key in the game).
    admin: boolean;
    // Why the account is banned, or null if it isn't.
    banned: string | null;
    // The address it last came in from (null if it never has).
    lastAddress: string | null;
}

// How long a code works, and how many guesses it gets.
export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;

export type CodeCheck = 'right' | 'wrong' | 'none';

// The most letters kept for a player (the oldest go first), and how long
// the news is kept, unless the server's rules say otherwise.
export const MAILBOX = 50;
export const NEWS_DAYS = 7;

export interface Letter {
    id: number;
    from: string;
    text: string;
    sentAt: number;
    read: boolean;
}

export interface NewsItem {
    text: string;
    at: number;
}

// Names: 2 to 20 letters, digits, spaces and ' - . (starting with a letter
// or digit). They're shown to other players, so nothing that could be markup.
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '.-]{1,19}$/;

export function validName(name: string): boolean {
    return NAME_PATTERN.test(name) && !name.includes('  ') && name === name.trim();
}

export class Store {
    private readonly db: Database;
    private readonly mailbox: number;
    private readonly newsDays: number;

    // `path` is a file, or ':memory:' for a database that's thrown away. The
    // database is brought up to date (see migrations.ts), and each step
    // taken is logged.
    public constructor(path: string, { log = () => undefined, mailbox = MAILBOX, newsDays = NEWS_DAYS }: { log?(line: string): void; mailbox?: number; newsDays?: number } = {}) {
        this.mailbox = mailbox;
        this.newsDays = newsDays;
        this.db = new Database(path, { create: true, strict: true });
        this.db.run('PRAGMA journal_mode = WAL');
        for (const step of migrate(this.db)) {
            log(`Database: ${step}`);
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
        const row: unknown = this.db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE name = $name`).get({ name });
        return row === null ? null : readAccount(row);
    }

    // Every account, by name.
    public accounts(): Account[] {
        const rows: unknown = this.db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY name`).all();
        return (Array.isArray(rows) ? rows : []).map((row: unknown) => readAccount(row));
    }

    // Removes the accounts made before `before` that never confirmed their
    // email or played (so names aren't held by accounts no one finished
    // making); their names.
    public removeUnfinishedAccounts(before: Date): string[] {
        const rows: unknown = this.db
            .query('SELECT id, name FROM accounts WHERE email_confirmed = 0 AND last_login IS NULL AND admin = 0 AND created_at < $before AND id NOT IN (SELECT account_id FROM players)')
            .all({ before: before.toISOString() });
        const gone = (Array.isArray(rows) ? rows : []).map((row: unknown) => {
            const r = record(row, 'account');
            return { id: field(r, 'id', 'account', integer), name: field(r, 'name', 'account', string) };
        });
        this.db.transaction(() => {
            for (const { id } of gone) {
                for (const table of ['codes', 'letters', 'days']) {
                    this.db.query(`DELETE FROM ${table} WHERE account_id = $id`).run({ id });
                }
                this.db.query('DELETE FROM accounts WHERE id = $id').run({ id });
            }
        })();
        return gone.map(({ name }) => name);
    }

    public setAdmin(accountId: number, admin: boolean): void {
        this.db.query('UPDATE accounts SET admin = $admin WHERE id = $id').run({ id: accountId, admin: admin ? 1 : 0 });
    }

    // Bans the account, saying why (or lifts it, with null).
    public setBanned(accountId: number, reason: string | null): void {
        this.db.query('UPDATE accounts SET banned = $reason WHERE id = $id').run({ id: accountId, reason });
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

    // ---- Letters between players

    public sendLetter(accountId: number, from: string, text: string, at: number): void {
        this.db.query('INSERT INTO letters (account_id, sender, text, sent_at) VALUES ($id, $from, $text, $at)').run({ id: accountId, from, text, at });
        this.db
            .query('DELETE FROM letters WHERE account_id = $id AND id NOT IN (SELECT id FROM letters WHERE account_id = $id ORDER BY sent_at DESC, id DESC LIMIT $keep)')
            .run({ id: accountId, keep: this.mailbox });
    }

    // A player's letters, newest first.
    public letters(accountId: number): Letter[] {
        const rows: unknown = this.db.query('SELECT id, sender, text, sent_at, read FROM letters WHERE account_id = $id ORDER BY sent_at DESC, id DESC').all({ id: accountId });
        return (Array.isArray(rows) ? rows : []).map((row: unknown) => {
            const r = record(row, 'letter');
            return {
                id: field(r, 'id', 'letter', integer),
                from: field(r, 'sender', 'letter', string),
                text: field(r, 'text', 'letter', string),
                sentAt: field(r, 'sent_at', 'letter', integer),
                read: field(r, 'read', 'letter', oneOf([0, 1])) === 1,
            };
        });
    }

    public unreadLetters(accountId: number): number {
        const row: unknown = this.db.query('SELECT COUNT(*) AS n FROM letters WHERE account_id = $id AND read = 0').get({ id: accountId });
        return row === null ? 0 : field(record(row, 'count'), 'n', 'count', integer);
    }

    public markLettersRead(accountId: number): void {
        this.db.query('UPDATE letters SET read = 1 WHERE account_id = $id').run({ id: accountId });
    }

    // ---- The news

    // A line of news (news older than the days it's kept is let go).
    public addNews(text: string, at: number): void {
        this.db.query('INSERT INTO news (text, at) VALUES ($text, $at)').run({ text, at });
        this.db.query('DELETE FROM news WHERE at < $before').run({ before: at - this.newsDays * 86_400_000 });
    }

    // The news since a time, newest first.
    public news(since: number): NewsItem[] {
        const rows: unknown = this.db.query('SELECT text, at FROM news WHERE at >= $since ORDER BY at DESC, id DESC').all({ since });
        return (Array.isArray(rows) ? rows : []).map((row: unknown) => {
            const r = record(row, 'news');
            return { text: field(r, 'text', 'news', string), at: field(r, 'at', 'news', integer) };
        });
    }

    // ---- The bounty board

    // Gold on a player's head (the poster has paid it already).
    public postBounty(targetId: number, posterId: number, amount: number, at: number): void {
        this.db.query('INSERT INTO bounties (target_id, poster_id, amount, at) VALUES ($target, $poster, $amount, $at)').run({ target: targetId, poster: posterId, amount, at });
    }

    // Every player with a price on their head, the biggest first.
    public bounties(): { name: string; amount: number }[] {
        const rows: unknown = this.db
            .query('SELECT a.name, SUM(b.amount) AS amount FROM bounties b JOIN accounts a ON a.id = b.target_id GROUP BY b.target_id ORDER BY amount DESC, a.name COLLATE NOCASE')
            .all();
        return (Array.isArray(rows) ? rows : []).map((row: unknown) => {
            const r = record(row, 'bounty');
            return { name: field(r, 'name', 'bounty', string), amount: field(r, 'amount', 'bounty', integer) };
        });
    }

    // Takes down every bounty on a player; what they came to.
    public claimBounties(targetId: number): number {
        return this.db.transaction(() => {
            const row: unknown = this.db.query('SELECT COALESCE(SUM(amount), 0) AS total FROM bounties WHERE target_id = $id').get({ id: targetId });
            this.db.query('DELETE FROM bounties WHERE target_id = $id').run({ id: targetId });
            return row === null ? 0 : field(record(row, 'bounty'), 'total', 'bounty', integer);
        })();
    }

    // ---- The world's state (as JSON, unchecked: the game checks it)

    public worldValues(): Record<string, unknown> {
        const rows: unknown = this.db.query('SELECT name, value FROM world').all();
        const values: Record<string, unknown> = {};
        for (const row of Array.isArray(rows) ? rows : []) {
            const r = record(row, 'world');
            const value: unknown = JSON.parse(field(r, 'value', 'world', string));
            values[field(r, 'name', 'world', string)] = value;
        }
        return values;
    }

    public setWorldValue(name: string, value: unknown): void {
        this.db.query('INSERT INTO world (name, value) VALUES ($name, $value) ON CONFLICT(name) DO UPDATE SET value = $value').run({ name, value: JSON.stringify(value) });
    }

    // ---- Days

    // The day a player's daily things (fights, daily flags) belong to, and
    // their fights that day; null if they've had none.
    public playerDay(accountId: number): { day: string; fights: number } | null {
        const row: unknown = this.db.query('SELECT day, fights FROM days WHERE account_id = $id').get({ id: accountId });
        if (row === null) {
            return null;
        }

        const r = record(row, 'day');
        return { day: field(r, 'day', 'day', string), fights: field(r, 'fights', 'day', integer) };
    }

    public setPlayerDay(accountId: number, day: string, fights: number): void {
        this.db
            .query('INSERT INTO days (account_id, day, fights) VALUES ($id, $day, $fights) ON CONFLICT(account_id) DO UPDATE SET day = $day, fights = $fights')
            .run({ id: accountId, day, fights });
    }

    // Small things the server keeps about itself (the day it last saw).
    public meta(name: string): string | null {
        const row: unknown = this.db.query('SELECT value FROM meta WHERE name = $name').get({ name });
        return row === null ? null : field(record(row, 'meta'), 'value', 'meta', string);
    }

    public setMeta(name: string, value: string): void {
        this.db.query('INSERT INTO meta (name, value) VALUES ($name, $value) ON CONFLICT(name) DO UPDATE SET value = $value').run({ name, value });
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

    public noteLogin(accountId: number, address: string | null = null): void {
        this.db.query('UPDATE accounts SET last_login = $now, last_address = COALESCE($address, last_address) WHERE id = $id').run({ id: accountId, now: now(), address });
    }

    // ---- Bans on addresses

    // Why an address is banned, or null if it isn't.
    public addressBan(address: string): string | null {
        const row: unknown = this.db.query('SELECT reason FROM address_bans WHERE address = $address').get({ address });
        return row === null ? null : field(record(row, 'ban'), 'reason', 'ban', string);
    }

    public banAddress(address: string, reason: string): void {
        this.db.query('INSERT INTO address_bans (address, reason, at) VALUES ($address, $reason, $at) ON CONFLICT(address) DO UPDATE SET reason = $reason, at = $at').run({ address, reason, at: now() });
    }

    // False if it wasn't banned.
    public unbanAddress(address: string): boolean {
        return this.db.query('DELETE FROM address_bans WHERE address = $address').run({ address }).changes > 0;
    }

    public addressBans(): { address: string; reason: string }[] {
        const rows: unknown = this.db.query('SELECT address, reason FROM address_bans ORDER BY address').all();
        return (Array.isArray(rows) ? rows : []).map((row: unknown) => {
            const r = record(row, 'ban');
            return { address: field(r, 'address', 'ban', string), reason: field(r, 'reason', 'ban', string) };
        });
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


    // (Its experience and gold are kept beside it too, for the rankings.)
    public savePlayer(accountId: number, player: unknown): void {
        const whole = (key: string): number => {
            const value: unknown = typeof player === 'object' && player !== null && key in player ? Reflect.get(player, key) : 0;
            return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
        };
        this.db
            .query(`INSERT INTO players (account_id, state, saved_at, exp, gold) VALUES ($id, $state, $now, $exp, $gold)
                ON CONFLICT(account_id) DO UPDATE SET state = $state, saved_at = $now, exp = $exp, gold = $gold`)
            .run({ id: accountId, state: JSON.stringify(player), now: now(), exp: whole('exp'), gold: whole('gold') });
    }

    // The players with the most experience, most first (then by name), and
    // how many players there are.
    public rankings(limit: number): { players: { name: string; exp: number; gold: number }[]; total: number } {
        const rows: unknown = this.db
            .query('SELECT a.name, p.exp, p.gold FROM players p JOIN accounts a ON a.id = p.account_id ORDER BY p.exp DESC, a.name COLLATE NOCASE LIMIT $limit')
            .all({ limit });
        const count: unknown = this.db.query('SELECT COUNT(*) AS n FROM players').get();
        return {
            players: (Array.isArray(rows) ? rows : []).map((row: unknown) => {
                const r = record(row, 'ranking');
                return { name: field(r, 'name', 'ranking', string), exp: field(r, 'exp', 'ranking', integer), gold: field(r, 'gold', 'ranking', integer) };
            }),
            total: count === null ? 0 : field(record(count, 'count'), 'n', 'count', integer),
        };
    }
}

const now = (): string => new Date().toISOString();

const ACCOUNT_COLUMNS = 'id, name, password_hash, email, email_confirmed, admin, banned, last_address';

function readAccount(row: unknown): Account {
    const r = record(row, 'account');
    const nullable = (key: string): string | null => (r[key] === null ? null : field(r, key, 'account', string));
    return {
        id: field(r, 'id', 'account', integer),
        name: field(r, 'name', 'account', string),
        passwordHash: field(r, 'password_hash', 'account', string),
        email: nullable('email'),
        emailConfirmed: field(r, 'email_confirmed', 'account', oneOf([0, 1])) === 1,
        admin: field(r, 'admin', 'account', oneOf([0, 1])) === 1,
        banned: nullable('banned'),
        lastAddress: nullable('last_address'),
    };
}
