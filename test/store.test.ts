import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { CODE_MINUTES, CODE_TRIES, Store, validName } from '../../server/store.ts';
import { tempDir } from '../helpers.ts';

describe('Store', () => {
    test('accounts: names are unique in any case, and looked up in any case', () => {
        const store = new Store(':memory:');
        expect(store.createAccount('Hero', 'hash', 'hero@example.com')).toEqual({ id: 1, name: 'Hero', passwordHash: 'hash', email: 'hero@example.com', emailConfirmed: false });
        expect(store.createAccount('HERO', 'other', 'x@example.com')).toBeNull();
        expect(store.account('hero')?.name).toBe('Hero');
        expect(store.account('nobody')).toBeNull();
        store.noteLogin(1);
    });

    test('players: saved as JSON and loaded back; saving again replaces', () => {
        const store = new Store(':memory:');
        const { id } = store.createAccount('A1', 'h', 'a@example.com') ?? { id: 0 };
        expect(store.loadPlayer(id)).toBeNull();
        store.savePlayer(id, { gold: 5, items: { stick: 1 } });
        store.savePlayer(id, { gold: 7 });
        expect(store.loadPlayer(id)).toEqual({ gold: 7 });
    });

    test('keeps everything in its file', () => {
        const path = join(tempDir(), 'game.sqlite');
        const first = new Store(path);
        first.savePlayer(first.createAccount('Kept', 'h', 'k@example.com')?.id ?? 0, { gold: 3 });
        first.close();
        const again = new Store(path);
        expect(again.account('kept')?.id).toBe(1);
        expect(again.loadPlayer(1)).toEqual({ gold: 3 });
    });

    test('email addresses are confirmed, and changing one needs confirming again; passwords change', () => {
        const store = new Store(':memory:');
        const id = store.createAccount('Hero', 'h', 'old@example.com')?.id ?? 0;
        store.confirmEmail(id);
        expect(store.account('hero')).toMatchObject({ email: 'old@example.com', emailConfirmed: true });
        store.saveCode(id, 'confirm', 'code', 1);
        store.setEmail(id, 'new@example.com');
        expect(store.account('hero')).toMatchObject({ email: 'new@example.com', emailConfirmed: false });
        expect(store.codeSentAt(id, 'confirm')).toBeNull();
        store.setPassword(id, 'h2');
        expect(store.account('hero')?.passwordHash).toBe('h2');
    });

    test('a database from before email addresses gets them (empty)', () => {
        const path = join(tempDir(), 'old.sqlite');
        const old = new Database(path, { create: true });
        old.run('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT)');
        old.run("INSERT INTO accounts (name, password_hash, created_at) VALUES ('Old', 'h', 'then')");
        old.close();
        const store = new Store(path);
        expect(store.account('old')).toEqual({ id: 1, name: 'Old', passwordHash: 'h', email: null, emailConfirmed: false });
        store.close();
    });
});

describe('codes', () => {
    const MINUTE = 60_000;

    function withCode(): { store: Store; id: number } {
        const store = new Store(':memory:');
        const id = store.createAccount('Hero', 'h', 'h@example.com')?.id ?? 0;
        store.saveCode(id, 'reset', 'right', 1000);
        return { store, id };
    }

    test('the right code works once; each purpose has its own', () => {
        const { store, id } = withCode();
        expect(store.codeSentAt(id, 'reset')).toBe(1000);
        expect(store.codeSentAt(id, 'confirm')).toBeNull();
        expect(store.checkCode(id, 'confirm', 'right', 2000)).toBe('none');
        expect(store.checkCode(id, 'reset', 'right', 2000)).toBe('right');
        expect(store.checkCode(id, 'reset', 'right', 2000)).toBe('none');
        expect(store.codeSentAt(id, 'reset')).toBeNull();
    });

    test(`a code runs out after ${CODE_MINUTES} minutes`, () => {
        const { store, id } = withCode();
        expect(store.checkCode(id, 'reset', 'right', 1000 + CODE_MINUTES * MINUTE + 1)).toBe('none');
    });

    test(`a code runs out after ${CODE_TRIES} wrong guesses`, () => {
        const { store, id } = withCode();
        for (let i = 0; i < CODE_TRIES; i++) {
            expect(store.checkCode(id, 'reset', 'wrong', 2000)).toBe('wrong');
        }
        expect(store.checkCode(id, 'reset', 'right', 2000)).toBe('none');
    });

    test('a new code replaces the old one, with its guesses', () => {
        const { store, id } = withCode();
        expect(store.checkCode(id, 'reset', 'wrong', 2000)).toBe('wrong');
        store.saveCode(id, 'reset', 'newer', 3000);
        expect(store.checkCode(id, 'reset', 'right', 4000)).toBe('wrong');
        expect(store.checkCode(id, 'reset', 'newer', 4000)).toBe('right');
    });
});

test.each([
    ['Hero', true],
    ['Al', true],
    ["O'Brien-Smith Jr.", true],
    ['A', false],
    ['x'.repeat(21), false],
    [' Hero', false],
    ['Hero ', false],
    ['Two  Spaces', false],
    ['{red}Bob', false],
    ['-dash', false],
])('validName(%p) is %p', (name, valid) => {
    expect(validName(name)).toBe(valid);
});
