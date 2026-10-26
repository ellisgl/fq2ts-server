import { describe, expect, test } from 'bun:test';
import { Gifts, OFFER_SECONDS } from '../src/gifts.ts';
import { Realm } from '../src/realm.ts';
import { Store } from '../src/store.ts';
import { itemCatalogue, makeGame, newPlayer, scriptContext, type TestFlags, type TestWorld } from '@fq2js/engine/fixture';
import { pick, screenText, typed } from '@fq2js/engine/testing';
import { ItemCatalogue, readItems } from '@fq2js/engine/items';

// Ann (1) giving, Bob (2) beside her on the map, with what each hears.
function setting({ items = itemCatalogue } = {}) {
    let now = 1_000_000;
    const store = new Store(':memory:');
    store.createAccount('Ann', 'h', 'a@example.com');
    store.createAccount('Bob', 'h', 'b@example.com');
    const realm = new Realm<TestFlags, TestWorld>();
    const heard: Record<string, string[]> = { Ann: [], Bob: [] };
    const games = {
        Ann: makeGame({ player: newPlayer({ gold: 100, items: { stick: 1, wildberries: 3 }, weapon: 'stick' }), items }).game,
        Bob: makeGame({ player: newPlayer({ gold: 5 }), items }).game,
    };
    for (const [id, name, x] of [[1, 'Ann', 10], [2, 'Bob', 11]] as const) {
        const game = games[name];
        Object.defineProperty(game, 'waiting', { get: () => true });
        game.notify = (text) => {
            heard[name]?.push(text);
        };
        realm.claim(id, name);
        realm.attach(id, game);
        realm.moved(id, { screen: 1, x, y: 10 });
    }
    // (Not what was heard as they arrived.)
    heard['Ann'] = [];
    heard['Bob'] = [];
    const gifts = new Gifts<TestFlags, TestWorld>({ realm, store, items, now: () => now });
    const ann = { id: 1, name: 'Ann' };
    const bob = { id: 2, name: 'Bob' };
    // Each plays in their own game.
    const as = (who: 'Ann' | 'Bob', steps: (string | (() => string))[]) => scriptContext({ player: games[who].playing, steps, items });
    return { store, realm, gifts, heard, games, ann, bob, as, later: (ms: number) => (now += ms) };
}

describe('giving', () => {
    test('gold: offered, accepted, and moved from one to the other; both are saved and told', async () => {
        const { gifts, heard, games, ann, bob, as, store } = setting();
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(0), ...typed('40'), 'x']).g);
        expect(heard['Bob']).toEqual(['{lightgreen}Ann offers you 40 gold. (A to accept or refuse it.)']);
        // Nothing moves until Bob accepts.
        expect(games.Ann.playing.gold).toBe(100);

        const bobs = as('Bob', [...pick(0), 'x']);
        await gifts.accept(bob)(bobs.g);
        expect(bobs.g.gold).toBe(45);
        expect(games.Ann.playing.gold).toBe(60);
        expect(store.loadPlayer(1)).toMatchObject({ gold: 60 });
        expect(heard['Ann']).toEqual(['{lightgreen}Bob took 40 gold from you. That was kind.']);
        expect(gifts.size).toBe(0);
    });

    test('an item (the last of it, unequipped as it goes)', async () => {
        const { gifts, games, ann, bob, as } = setting();
        // (Ann's list: Gold, Stick, Wildberries.)
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(1), 'x']).g);
        const bobs = as('Bob', [...pick(0), 'x']);
        await gifts.accept(bob)(bobs.g);
        expect(bobs.g.count('stick')).toBe(1);
        expect(games.Ann.playing).toMatchObject({ weapon: null });
        expect(games.Ann.playing.items['stick']).toBeUndefined();
    });

    test('refused, nothing moves, and the giver is told', async () => {
        const { gifts, heard, games, ann, bob, as } = setting();
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(0), ...typed('40'), 'x']).g);
        await gifts.accept(bob)(as('Bob', pick(1)).g);
        expect(games.Ann.playing.gold).toBe(100);
        expect(heard['Ann']).toEqual(['{yellow}Bob turned down 40 gold.']);
    });

    test("the giver must still have it when it's accepted", async () => {
        const { gifts, games, ann, bob, as } = setting();
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(0), ...typed('90'), 'x']).g);
        games.Ann.playing.gold = 10;
        const bobs = as('Bob', [...pick(0), 'x']);
        await gifts.accept(bob)(bobs.g);
        expect(screenText(bobs.term.screen)).toContain("Ann hasn't 90 gold to give any more.");
        expect([bobs.g.gold, games.Ann.playing.gold]).toEqual([5, 10]);
    });

    test('nor the giver gone from the realm; offers go with them', async () => {
        const { gifts, realm, ann, bob, as } = setting();
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(0), ...typed('40'), 'x']).g);
        realm.release(1);
        gifts.forget(1);
        const bobs = as('Bob', []);
        await gifts.accept(bob)(bobs.g);
        expect(screenText(bobs.term.screen)).toContain('No one has offered you anything.');
    });

    test(`an offer lasts ${OFFER_SECONDS} seconds`, async () => {
        const { gifts, ann, bob, as, later } = setting();
        await gifts.give(ann)(as('Ann', [...pick(0), ...pick(0), ...typed('40'), 'x']).g);
        later(OFFER_SECONDS * 1000 + 1);
        const bobs = as('Bob', []);
        await gifts.accept(bob)(bobs.g);
        expect(screenText(bobs.term.screen)).toContain('No one has offered you anything.');
    });

    test("more than they have, none, and quest items aren't offered", async () => {
        const items = new ItemCatalogue([...itemCatalogue.all(), readItems([{ id: 'pass', name: 'Pass', kind: 'quest' }]).get('pass')]);
        const { gifts, heard, ann, as, games } = setting({ items });
        games.Ann.playing.items['pass'] = 1;
        const too = as('Ann', [...pick(0), ...pick(0), ...typed('500'), 'x']);
        await gifts.give(ann)(too.g);
        expect(screenText(too.term.screen)).toContain("You haven't that much.");
        const list = as('Ann', [...pick(0), () => {
            expect(screenText(list.term.screen)).not.toContain('Pass');
            return 'escape';
        }]);
        await gifts.give(ann)(list.g);
        expect(heard['Bob']).toEqual([]);
    });

    test("with no one near, there's no one to give to", async () => {
        const { gifts, realm, ann, as } = setting();
        realm.moved(2, { screen: 1, x: 40, y: 15 });
        const { g, term } = as('Ann', []);
        await gifts.give(ann)(g);
        expect(screenText(term.screen)).toContain("There's no one close enough to give anything to.");
    });
});
