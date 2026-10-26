import { describe, expect, spyOn, test } from 'bun:test';
import { Realm, OTHER_PLAYER } from '../src/realm.ts';
import { rankings, whoIsOnline } from '../src/lists.ts';
import { Store } from '../src/store.ts';
import { makeGame, newPlayer, scriptContext, testWorld, type TestFlags } from '@fq2ts/engine/fixture';
import { screenText } from '@fq2ts/engine/testing';

// A member's game, with what the realm tells it counted.
function member(realm: Realm<TestFlags>, id: number, name: string) {
    const { game } = makeGame();
    const notify = spyOn(game, 'notify');
    const othersChanged = spyOn(game, 'othersChanged');
    expect(realm.claim(id, name)).toBe(true);
    realm.attach(id, game);
    return { game, notify, othersChanged };
}

describe('Realm', () => {
    test('an account can only be in once', () => {
        const realm = new Realm<TestFlags>();
        expect(realm.claim(1, 'Ann')).toBe(true);
        expect(realm.claim(1, 'Ann')).toBe(false);
        realm.release(1);
        expect(realm.claim(1, 'Ann')).toBe(true);
    });

    test('everyone else hears who enters and leaves', () => {
        const realm = new Realm<TestFlags>();
        const ann = member(realm, 1, 'Ann');
        const bob = member(realm, 2, 'Bob');
        expect(ann.notify).toHaveBeenCalledWith('{lightcyan}Bob enters the realm.');
        expect(bob.notify).not.toHaveBeenCalled();
        realm.release(2);
        expect(ann.notify).toHaveBeenLastCalledWith('{lightcyan}Bob leaves the realm.');
    });

    test('an account that never got as far as playing comes and goes unannounced', () => {
        const realm = new Realm<TestFlags>();
        const ann = member(realm, 1, 'Ann');
        realm.claim(2, 'Bob');
        realm.release(2);
        expect(ann.notify).not.toHaveBeenCalled();
    });

    test('players see the others on their screen, and redraw when they move', () => {
        const realm = new Realm<TestFlags>();
        const ann = member(realm, 1, 'Ann');
        const bob = member(realm, 2, 'Bob');
        realm.moved(1, { screen: 1, x: 10, y: 10 });
        realm.moved(2, { screen: 1, x: 12, y: 10 });
        expect(realm.figures(1, 1)).toEqual([{ x: 12, y: 10, ...OTHER_PLAYER }]);
        expect(realm.figures(2, 1)).toEqual([{ x: 10, y: 10, ...OTHER_PLAYER }]);
        expect(realm.figures(1, 2)).toEqual([]);
        // Ann saw Bob arrive; Bob, arriving, draws Ann himself.
        expect(ann.othersChanged).toHaveBeenCalledTimes(1);
        expect(bob.othersChanged).toHaveBeenCalledTimes(0);

        // Bob walks off to screen 2: Ann sees him go.
        realm.moved(2, { screen: 2, x: 1, y: 10 });
        expect(ann.othersChanged).toHaveBeenCalledTimes(2);
        expect(realm.figures(1, 1)).toEqual([]);

        // Ann follows; Bob, on screen 2, sees her arrive.
        realm.moved(1, { screen: 2, x: 1, y: 11 });
        expect(bob.othersChanged).toHaveBeenCalledTimes(1);

        // And when Ann leaves, Bob sees her go.
        realm.release(1);
        expect(bob.othersChanged).toHaveBeenCalledTimes(2);
        expect(realm.figures(2, 2)).toEqual([]);
    });

    test('online lists who is playing, by name, with where they are', () => {
        const realm = new Realm<TestFlags>();
        member(realm, 2, 'Zed');
        member(realm, 1, 'Ann');
        realm.claim(3, 'Logging In');
        realm.moved(2, { screen: 82, x: 5, y: 5 });
        expect(realm.online()).toEqual([
            { accountId: 1, name: 'Ann', place: null },
            { accountId: 2, name: 'Zed', place: { screen: 82, x: 5, y: 5 } },
        ]);
        expect(realm.size).toBe(3);
    });
});

describe('P and L', () => {
    test("P lists who's in the realm and where, marking the player", async () => {
        const realm = new Realm<TestFlags>();
        member(realm, 1, 'Ann');
        member(realm, 2, 'Bob');
        realm.moved(1, { screen: 1, x: 10, y: 10 });
        const world = testWorld();
        world.setName(1, 'Frog Pond');
        const { g, term } = scriptContext({
            steps: [
                () => {
                    const text = screenText(term.screen);
                    expect(text).toContain("Who's in the realm (2)");
                    expect(text).toMatch(/Ann +Frog Pond \(you\)/);
                    expect(text).toMatch(/Bob +arriving/);
                    return 'escape';
                },
            ],
        });
        await whoIsOnline(realm, world, 1)(g);
        expect(term.remaining).toBe(0);
    });

    test('L ranks every saved player by experience, marking who is in (without reading their saves)', async () => {
        const store = new Store(':memory:');
        const save = (name: string, exp: number): void => {
            const id = store.createAccount(name, 'h', `${name}@example.com`)?.id ?? 0;
            store.savePlayer(id, newPlayer({ name, exp, gold: exp * 2 }));
        };
        save('Low', 5);
        save('High', 500);
        save('Mid', 50);
        store.savePlayer(store.createAccount('Broken', 'h', 'b@example.com')?.id ?? 0, { hp: 'lots' });
        const realm = new Realm<TestFlags>();
        member(realm, 9, 'Mid');
        const { g, term } = scriptContext({
            steps: [
                () => {
                    const rows = screenText(term.screen).split('\n').filter((line) => /^\s+\d/.test(line));
                    expect(rows.map((line) => line.trim().split(/\s+/).slice(0, 3))).toEqual([
                        ['1', 'High', '500'],
                        ['2', '*Mid', '50'],
                        ['3', 'Low', '5'],
                        // (A save with no experience in it counts as none.)
                        ['4', 'Broken', '0'],
                    ]);
                    expect(screenText(term.screen)).toContain('Players (4)');
                    return 'escape';
                },
            ],
        });
        await rankings(realm, store)(g);
        expect(term.remaining).toBe(0);
    });
});
