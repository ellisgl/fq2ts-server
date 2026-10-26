import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Days, NEW_DAY, dayOf } from '../src/days.ts';
import { FIGHTS_PER_DAY, asMonster, attack } from '../src/pvp.ts';
import { Realm } from '../src/realm.ts';
import { Store } from '../src/store.ts';
import { content, itemCatalogue, makeGame, newPlayer, scriptContext, testWorld, type TestFlags, type TestWorld } from '@fq2js/engine/fixture';
import { screenText } from '@fq2js/engine/testing';

const HOUR = 3_600_000;
// Midday, and midnight after it, on the server's clock.
const MIDDAY = new Date(2026, 9, 25, 12, 0).getTime();
const MIDNIGHT = new Date(2026, 9, 26, 0, 0).getTime();

// Test Quest's content, with `visits` a daily flag.
const daily = { ...content, daily: ['visits' as const] };

let random: Mock<() => number> | null = null;
afterEach(() => {
    random?.mockRestore();
    random = null;
});

describe('days', () => {
    test('dayOf is the date by the server clock', () => {
        expect(dayOf(MIDDAY)).toBe('2026-10-25');
        expect(dayOf(MIDNIGHT - 1)).toBe('2026-10-25');
        expect(dayOf(MIDNIGHT)).toBe('2026-10-26');
    });

    test('a new day: the news says so, and players in the realm start their day again', () => {
        let now = MIDDAY;
        const store = new Store(':memory:');
        const realm = new Realm<TestFlags, TestWorld>();
        const days = new Days({ store, content: daily, realm, now: () => now });
        expect(days.today).toBe('2026-10-25');
        // (The server's first day isn't news.)
        expect(store.news(0)).toEqual([]);

        const { game } = makeGame({ player: newPlayer({}, { visits: 4 }) });
        const notify = spyOn(game, 'notify');
        realm.claim(1, 'Ann');
        realm.attach(1, game);
        store.createAccount('Ann', 'h', 'a@example.com');
        days.fought(1);
        expect(days.fights(1)).toBe(1);

        now = MIDNIGHT + HOUR;
        days.check();
        expect(days.today).toBe('2026-10-26');
        expect(store.news(0).map(({ text }) => text)).toEqual([NEW_DAY]);
        expect(game.playing.flags.visits).toBe(0);
        expect(notify).toHaveBeenCalledWith(NEW_DAY);
        expect(days.fights(1)).toBe(0);
        // Only once.
        days.check();
        expect(store.news(0)).toHaveLength(1);
    });

    test('a server started on a later day than it last saw starts the new day', () => {
        const store = new Store(':memory:');
        const realm = new Realm<TestFlags, TestWorld>();
        new Days({ store, content: daily, realm, now: () => MIDDAY });
        new Days({ store, content: daily, realm, now: () => MIDNIGHT + 5 * HOUR });
        expect(store.news(0).map(({ text }) => text)).toEqual([NEW_DAY]);
    });

    test('a player back on a later day has their daily flags reset as they arrive', () => {
        let now = MIDDAY;
        const store = new Store(':memory:');
        const id = store.createAccount('Ann', 'h', 'a@example.com')?.id ?? 0;
        store.savePlayer(id, newPlayer({}, { visits: 3, met: true }));
        const days = new Days({ store, content: daily, realm: new Realm<TestFlags, TestWorld>(), now: () => now });
        days.arrive(id);
        // (Their first arrival: today's their day now.)
        expect(store.loadPlayer(id)).toMatchObject({ flags: { visits: 0, met: true } });
        store.savePlayer(id, newPlayer({}, { visits: 2 }));
        days.arrive(id);
        expect(store.loadPlayer(id)).toMatchObject({ flags: { visits: 2 } });

        now = MIDNIGHT;
        days.check();
        days.arrive(id);
        expect(store.loadPlayer(id)).toMatchObject({ flags: { visits: 0 } });
    });
});

describe('fights between players', () => {
    test('a player as a monster: their stats, gear, half their gold, a tenth of their experience', () => {
        const ann = newPlayer({ hp: 60, gold: 101, exp: 250, strength: 12, defense: 7, items: { stick: 1, vest: 1 }, weapon: 'stick', armour: 'vest', sex: 'female' });
        expect(asMonster('Ann', ann, itemCatalogue)).toMatchObject({
            name: 'Ann',
            pronoun: 'she',
            hp: 60,
            defense: 7 + itemCatalogue.get('vest').power,
            gold: 50,
            exp: 25,
            attacks: [{ text: 'swings her Stick at you', power: 12 + itemCatalogue.get('stick').power }],
        });
        expect(asMonster('Bob', newPlayer({ exp: 0 }), itemCatalogue)).toMatchObject({ exp: 1, attacks: [{ text: 'swings his fists at you' }] });
    });

    // Ann (1) and Bob (2), side by side on screen 1 (or wherever Bob is put),
    // with Bob's game and what he hears.
    function arena({ bob = newPlayer({ gold: 80, exp: 100 }), bobAt = { screen: 1, x: 11, y: 10 }, world = testWorld() } = {}) {
        const store = new Store(':memory:');
        store.createAccount('Ann', 'h', 'a@example.com');
        store.createAccount('Bob', 'h', 'b@example.com');
        const realm = new Realm<TestFlags, TestWorld>();
        const days = new Days({ store, content, realm, now: () => MIDDAY });
        const bobs = makeGame({ player: bob });
        // (Bob is out on the map, waiting.)
        let waiting = true;
        Object.defineProperty(bobs.game, 'waiting', { get: () => waiting });
        const busy = (): void => {
            waiting = false;
        };
        const heard: string[] = [];
        spyOn(bobs.game, 'notify').mockImplementation((text) => {
            heard.push(text);
        });
        realm.claim(2, 'Bob');
        realm.attach(2, bobs.game);
        realm.moved(2, bobAt);
        realm.claim(1, 'Ann');
        realm.moved(1, { screen: 1, x: 10, y: 10 });
        const h = attack({ realm, store, days, world, items: itemCatalogue, me: { id: 1, name: 'Ann' }, now: () => MIDDAY });
        return { store, days, h, bob: bobs.game, heard, realm, busy };
    }

    test('winning: Ann takes half of Bob\'s gold and some experience; he is left on 1 hp, told, and saved; the news has it', async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { store, days, h, bob, heard } = arena({ bob: newPlayer({ gold: 80, exp: 100, hp: 5 }) });
        const { g, term } = scriptContext({ player: newPlayer({ gold: 10 }), steps: ['enter', 'enter', 'x', 'x'] });
        await h(g);
        expect(term.remaining).toBe(0);
        expect([g.gold, g.exp]).toEqual([50, 10]);
        expect(bob.playing).toMatchObject({ gold: 40, hp: 1 });
        expect(heard).toEqual(['{lightred}Ann attacks you!', '{lightred}Ann beat you, and took $40.']);
        expect(store.loadPlayer(2)).toMatchObject({ gold: 40, hp: 1 });
        expect(store.news(0).map(({ text }) => text)).toEqual(['{lightred}Ann beat Bob in a fight.']);
        expect(days.fights(1)).toBe(1);
    });

    test('losing: Bob takes half of Ann\'s gold, and she is left on 1 hp', async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { h, bob, heard } = arena({ bob: newPlayer({ gold: 0, hp: 9999, strength: 500 }) });
        const { g } = scriptContext({ player: newPlayer({ gold: 30 }), steps: ['enter', 'enter', 'enter', 'x'] });
        await h(g);
        expect([g.gold, g.hp]).toEqual([15, 1]);
        expect(bob.playing.gold).toBe(15);
        expect(heard.at(-1)).toBe("{lightgreen}You beat off Ann's attack, and took $15.");
    });

    test('running away: Bob hears of it, and nothing changes hands', async () => {
        const { h, bob, heard } = arena();
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { g } = scriptContext({ player: newPlayer({ gold: 30 }), steps: ['enter', 'right', 'enter'] });
        await h(g);
        expect(g.gold).toBe(30);
        expect(bob.playing.gold).toBe(80);
        expect(heard.at(-1)).toBe('{yellow}Ann attacked you, then ran away.');
    });

    test('not on a safe screen, not with no one near, not against someone beaten, and not too often', async () => {
        const said = async (h: ReturnType<typeof arena>['h'], steps: string[] = []): Promise<string> => {
            const { g, term } = scriptContext({ steps });
            await h(g);
            return screenText(term.screen);
        };
        const safe = testWorld();
        safe.setSafe(1, true);
        expect(await said(arena({ world: safe }).h)).toContain('No fighting here: this is a safe place.');
        expect(await said(arena({ bobAt: { screen: 1, x: 30, y: 10 } }).h)).toContain("There's no one close enough to fight.");
        expect(await said(arena({ bob: newPlayer({ hp: 1 }) }).h, ['enter', 'x'])).toContain('Bob is in no state to fight.');

        const { days, h } = arena();
        for (let i = 0; i < FIGHTS_PER_DAY; i++) {
            days.fought(1);
        }
        expect(await said(h)).toContain("You've fought enough for one day.");
    });

    test("if Bob leaves during the fight, Ann takes nothing (and his save isn't touched)", async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { store, h, realm } = arena({ bob: newPlayer({ gold: 80, hp: 5 }) });
        store.savePlayer(2, newPlayer({ gold: 999 }));
        const { g, term } = scriptContext({
            player: newPlayer({ gold: 10 }),
            steps: [
                // (Ann picks Bob; he leaves as she swings.)
                'enter',
                () => {
                    realm.release(2);
                    return 'enter';
                },
                'x',
                'x',
            ],
        });
        await h(g);
        expect(term.remaining).toBe(0);
        expect(g.gold).toBe(10);
        expect(store.loadPlayer(2)).toMatchObject({ gold: 999 });
    });

    test("if Bob gets busy (a fight, a shop...) while Ann chooses, there's no fight", async () => {
        const { h, heard, days, busy } = arena();
        const { g, term } = scriptContext({
            steps: [
                () => {
                    // (Bob walks into a fight of his own as Ann picks him.)
                    busy();
                    return 'enter';
                },
                () => {
                    expect(screenText(term.screen)).toContain('Bob has moved on.');
                    return 'x';
                },
            ],
        });
        await h(g);
        expect(term.remaining).toBe(0);
        expect(heard).toEqual([]);
        expect(days.fights(1)).toBe(0);
    });

    test("if Bob walks away while Ann chooses, there's no fight", async () => {
        const { h, heard, realm } = arena();
        const { g, term } = scriptContext({
            steps: [
                () => {
                    realm.moved(2, { screen: 1, x: 40, y: 15 });
                    return 'enter';
                },
                () => {
                    expect(screenText(term.screen)).toContain('Bob has moved on.');
                    return 'x';
                },
            ],
        });
        await h(g);
        expect(heard).toEqual([]);
    });

    test('choosing no one fights no one', async () => {
        const { h, heard, days } = arena();
        const { g } = scriptContext({ steps: ['down', 'enter'] });
        await h(g);
        expect(heard).toEqual([]);
        expect(days.fights(1)).toBe(0);
    });
});
