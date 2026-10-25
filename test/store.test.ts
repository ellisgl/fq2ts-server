import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Store, validName } from '../../server/store.ts';
import { tempDir } from '../helpers.ts';

describe('Store', () => {
    test('accounts: names are unique in any case, and looked up in any case', () => {
        const store = new Store(':memory:');
        expect(store.createAccount('Hero', 'hash')).toEqual({ id: 1, name: 'Hero', passwordHash: 'hash' });
        expect(store.createAccount('HERO', 'other')).toBeNull();
        expect(store.account('hero')?.name).toBe('Hero');
        expect(store.account('nobody')).toBeNull();
        store.noteLogin(1);
    });

    test('players: saved as JSON and loaded back; saving again replaces', () => {
        const store = new Store(':memory:');
        const { id } = store.createAccount('A1', 'h') ?? { id: 0 };
        expect(store.loadPlayer(id)).toBeNull();
        store.savePlayer(id, { gold: 5, items: { stick: 1 } });
        store.savePlayer(id, { gold: 7 });
        expect(store.loadPlayer(id)).toEqual({ gold: 7 });
    });

    test('keeps everything in its file', () => {
        const path = join(tempDir(), 'game.sqlite');
        const first = new Store(path);
        first.savePlayer(first.createAccount('Kept', 'h')?.id ?? 0, { gold: 3 });
        first.close();
        const again = new Store(path);
        expect(again.account('kept')?.id).toBe(1);
        expect(again.loadPlayer(1)).toEqual({ gold: 3 });
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
