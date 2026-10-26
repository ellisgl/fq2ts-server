import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runAdmin } from '../src/admin-cli.ts';
import { adminMenu } from '../src/admin.ts';
import { Realm } from '../src/realm.ts';
import { Store } from '../src/store.ts';
import { makeGame, scriptContext, type TestFlags, type TestWorld } from '@fq2js/engine/fixture';
import { pick, screenText, tempDir, typed } from '@fq2js/engine/testing';

describe('bun run admin', () => {
    // A data folder with a database holding Ann and Bob.
    function data(): string {
        const dir = tempDir();
        const store = new Store(join(dir, 'game.sqlite'));
        store.createAccount('Ann', 'h', 'ann@example.com');
        store.confirmEmail(1);
        store.createAccount('Bob', 'h', 'bob@example.com');
        store.close();
        return dir;
    }

    // Runs a command; its exit code and what it said.
    function admin(dir: string, ...args: string[]): { code: number; out: string[]; err: string[] } {
        const out: string[] = [];
        const err: string[] = [];
        const code = runAdmin({ args: [...args, '--data', dir], log: (l) => out.push(l), error: (l) => err.push(l) });
        return { code, out, err };
    }

    test('makes admins, bans and unbans, and lists it all', () => {
        const dir = data();
        expect(admin(dir, 'admin', 'ann')).toEqual({ code: 0, out: ['Ann is an admin.'], err: [] });
        expect(admin(dir, 'ban', 'Bob', 'Too', 'rude.').out).toEqual(['Bob is banned: Too rude.']);
        const listed = admin(dir, 'list').out;
        expect(listed[0]).toMatch(/^Ann +ann@example\.com +confirmed +admin$/);
        expect(listed[1]).toMatch(/^Bob +bob@example\.com +unconfirmed +banned: Too rude\.$/);
        expect(admin(dir, 'unban', 'bob').out).toEqual(["Bob isn't banned now."]);
        expect(admin(dir, 'unadmin', 'ann').out).toEqual(["Ann isn't an admin now."]);
        const store = new Store(join(dir, 'game.sqlite'));
        expect(store.account('ann')).toMatchObject({ admin: false, banned: null });
        expect(store.account('bob')).toMatchObject({ banned: null });
    });

    test.each([
        [['ban', 'Bob'], 'A ban needs a reason (the player is told it).'],
        [['ban'], 'ban needs a name.'],
        [['admin', 'Nobody'], 'There\'s no account called "Nobody".'],
        [['explode'], 'There\'s no command "explode". (-h lists them.)'],
    ])('%p is refused', (args, message) => {
        expect(admin(data(), ...args)).toMatchObject({ code: 1, err: [message] });
    });

    test('with no database, or no command, says so', () => {
        expect(admin(tempDir(), 'list').err[0]).toContain("There's no database at");
        expect(admin(data()).code).toBe(1);
        expect(admin(data(), '-h')).toMatchObject({ code: 0 });
    });
});

describe('the admin menu (!)', () => {
    const KICK = pick(0);
    const BAN = pick(1);
    const UNBAN = pick(2);
    const TELL = pick(3);

    // Ann (1, the admin) and Bob (2) in the realm, with a store, and what's
    // kicked, logged and heard.
    function realm() {
        const store = new Store(':memory:');
        store.createAccount('Ann', 'h', 'a@example.com');
        store.createAccount('Bob', 'h', 'b@example.com');
        const r = new Realm<TestFlags, TestWorld>();
        const heard: string[] = [];
        for (const [id, name] of [[1, 'Ann'], [2, 'Bob']] as const) {
            const { game } = makeGame();
            if (id === 2) {
                game.notify = (text) => {
                    heard.push(text);
                };
            }
            r.claim(id, name);
            r.attach(id, game);
        }
        const kicked: string[] = [];
        const logs: string[] = [];
        const menu = adminMenu({ realm: r, store, me: { id: 1, name: 'Ann' }, kick: (id, message) => kicked.push(`${id}: ${message}`), log: (l) => logs.push(l) });
        return { store, menu, kicked, logs, heard };
    }

    test('kicks a player, telling them why', async () => {
        const { menu, kicked, logs } = realm();
        const { g, term } = scriptContext({ steps: [...KICK, ...pick(0), ...typed('Spamming'), 'x'] });
        await menu(g);
        expect(term.remaining).toBe(0);
        expect(kicked).toEqual(['2: You were removed from the realm by Ann: Spamming']);
        expect(logs).toEqual(['Ann kicked Bob: Spamming']);
    });

    test('bans a player (kicking them if they are in), and lifts it', async () => {
        const { store, menu, kicked, logs } = realm();
        await menu(scriptContext({ steps: [...BAN, ...typed('bob'), ...typed('Cheating'), 'x'] }).g);
        expect(store.account('bob')?.banned).toBe('Cheating');
        expect(kicked).toEqual(['2: You are banned from the realm: Cheating']);
        await menu(scriptContext({ steps: [...UNBAN, ...typed('Bob'), 'x'] }).g);
        expect(store.account('bob')?.banned).toBeNull();
        expect(logs).toEqual(['Ann banned Bob: Cheating', "Ann lifted Bob's ban."]);
    });

    test('tells everyone something', async () => {
        const { menu, heard } = realm();
        await menu(scriptContext({ steps: [...TELL, ...typed('Server restarts at noon.'), 'x'] }).g);
        expect(heard).toEqual(['{lightmagenta}Ann (admin): Server restarts at noon.']);
    });

    test("won't ban yourself, no one, or without a reason; won't unban who isn't banned", async () => {
        const { store, menu, kicked } = realm();
        const said = async (steps: string[]): Promise<string> => {
            const { g, term } = scriptContext({ steps });
            await menu(g);
            return screenText(term.screen);
        };
        expect(await said([...BAN, ...typed('Ann'), 'x'])).toContain("You can't ban yourself.");
        expect(await said([...BAN, ...typed('Nobody'), 'x'])).toContain("There's no one by that name.");
        await said([...BAN, ...typed('Bob'), 'enter']);
        expect(store.account('bob')?.banned).toBeNull();
        expect(await said([...UNBAN, ...typed('Bob'), 'x'])).toContain("There's no one banned by that name.");
        expect(kicked).toEqual([]);
    });
});
