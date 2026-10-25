import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { MIGRATIONS, migrate, type Migration } from '../../server/migrations.ts';
import { Store } from '../../server/store.ts';
import { tempDir } from '../helpers.ts';

const version = (db: Database): unknown => db.query('PRAGMA user_version').get();
const tables = (db: Database): unknown[] => db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

describe('migrate', () => {
    test('a new database has every step, once', () => {
        const db = new Database(':memory:');
        expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.description));
        expect(version(db)).toEqual({ user_version: MIGRATIONS.length });
        expect(tables(db)).toEqual([{ name: 'accounts' }, { name: 'accounts_email' }, { name: 'codes' }, { name: 'players' }]);
        expect(migrate(db)).toEqual([]);
    });

    test('only the steps a database lacks are run, in order', () => {
        const db = new Database(':memory:');
        const ran: string[] = [];
        const step = (name: string): Migration => ({
            description: name,
            up: () => {
                ran.push(name);
            },
        });
        migrate(db, [step('a')]);
        expect(migrate(db, [step('a'), step('b'), step('c')])).toEqual(['b', 'c']);
        expect(ran).toEqual(['a', 'b', 'c']);
    });

    test('a step that fails changes nothing, and the steps after it are not run', () => {
        const db = new Database(':memory:');
        const steps: Migration[] = [
            { description: 'table', up: (d) => d.run('CREATE TABLE t (x INTEGER)') },
            {
                description: 'broken',
                up: (d) => {
                    d.run('INSERT INTO t VALUES (1)');
                    d.run('NOT SQL');
                },
            },
            { description: 'never', up: (d) => d.run('CREATE TABLE never (x INTEGER)') },
        ];
        expect(() => migrate(db, steps)).toThrow();
        expect(version(db)).toEqual({ user_version: 1 });
        expect(db.query('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
        expect(tables(db)).toEqual([{ name: 't' }]);
    });

    test('a database from a newer server is not used', () => {
        const db = new Database(':memory:');
        db.run(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
        expect(() => migrate(db)).toThrow(`The database is from a newer version of the server (layout ${MIGRATIONS.length + 1}; this one knows up to ${MIGRATIONS.length}).`);
    });
});

describe('databases from before there were steps', () => {
    const ACCOUNTS = 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT)';
    const PLAYERS = 'CREATE TABLE players (account_id INTEGER PRIMARY KEY, state TEXT NOT NULL, saved_at TEXT NOT NULL)';
    const EMAIL = [
        'ALTER TABLE accounts ADD COLUMN email TEXT',
        'ALTER TABLE accounts ADD COLUMN email_confirmed INTEGER NOT NULL DEFAULT 0',
        'CREATE TABLE codes (account_id INTEGER NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, sent_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, purpose))',
    ];
    const UNIQUE = 'CREATE UNIQUE INDEX accounts_email ON accounts (email COLLATE NOCASE) WHERE email_confirmed = 1';

    test.each([
        ['the first server', [ACCOUNTS, PLAYERS], MIGRATIONS.slice(1)],
        ['email addresses', [ACCOUNTS, PLAYERS, ...EMAIL], MIGRATIONS.slice(2)],
        ['unique addresses', [ACCOUNTS, PLAYERS, ...EMAIL, UNIQUE], []],
    ])('from %s: get the steps after', (_, sql, wanted) => {
        const db = new Database(':memory:');
        for (const statement of sql) {
            db.run(statement);
        }
        db.run("INSERT INTO accounts (name, password_hash, created_at) VALUES ('Kept', 'h', 'then')");
        // (Step 1 is run again for the first server's: it changes nothing.)
        const ran = migrate(db).filter((d) => d !== MIGRATIONS[0]?.description);
        expect(ran).toEqual(wanted.map((m) => m.description));
        expect(version(db)).toEqual({ user_version: MIGRATIONS.length });
        expect(db.query('SELECT name FROM accounts').all()).toEqual([{ name: 'Kept' }]);
    });
});

test('the store brings its database up to date, and logs the steps', () => {
    const logs: string[] = [];
    const path = join(tempDir(), 'logged.sqlite');
    new Store(path, { log: (line) => logs.push(line) }).close();
    expect(logs).toEqual(MIGRATIONS.map((m) => `Database: ${m.description}`));
    logs.length = 0;
    new Store(path, { log: (line) => logs.push(line) }).close();
    expect(logs).toEqual([]);
});
