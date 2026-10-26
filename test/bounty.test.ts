import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { MIN_BOUNTY, bountyBoard } from '../src/bounty.ts';
import { attack } from '../src/pvp.ts';
import { Days } from '../src/days.ts';
import { Realm } from '../src/realm.ts';
import { Store } from '../src/store.ts';
import { content, itemCatalogue, makeGame, newPlayer, scriptContext, testWorld, type TestFlags, type TestWorld } from '@fq2ts/engine/fixture';
import { pick, screenText, typed } from '@fq2ts/engine/testing';

let random: Mock<() => number> | null = null;
afterEach(() => {
    random?.mockRestore();
    random = null;
});

// Ann (1) and Bob (2), both having played; Ann in town (screen 1, safe).
function setting() {
    const store = new Store(':memory:');
    for (const name of ['Ann', 'Bob']) {
        const id = store.createAccount(name, 'h', `${name}@example.com`)?.id ?? 0;
        store.savePlayer(id, newPlayer({ name }));
    }
    const realm = new Realm<TestFlags, TestWorld>();
    const world = testWorld();
    world.setSafe(1, true);
    const heard: string[] = [];
    const { game } = makeGame();
    game.notify = (text) => {
        heard.push(text);
    };
    realm.claim(2, 'Bob');
    realm.attach(2, game);
    const board = bountyBoard({ realm, store, world, me: { id: 1, name: 'Ann' }, now: () => 5 });
    return { store, realm, world, heard, board };
}

const READ = pick(0);
const POST = pick(1);

describe('the store', () => {
    test('bounties add up on a head; claiming them takes them all down', () => {
        const { store } = setting();
        store.postBounty(2, 1, 50, 1);
        store.postBounty(2, 1, 25, 2);
        store.postBounty(1, 2, 10, 3);
        expect(store.bounties()).toEqual([{ name: 'Bob', amount: 75 }, { name: 'Ann', amount: 10 }]);
        expect(store.claimBounties(2)).toBe(75);
        expect(store.claimBounties(2)).toBe(0);
        expect(store.bounties()).toEqual([{ name: 'Ann', amount: 10 }]);
    });
});

describe('the board (K)', () => {
    test('posting: the gold is paid now; the news says how much, and the target is told (not who)', async () => {
        const { store, heard, board } = setting();
        const { g, term } = scriptContext({ player: newPlayer({ gold: 100 }), steps: [...POST, ...typed('bob'), ...typed('60'), 'x'] });
        await board(g);
        expect(term.remaining).toBe(0);
        expect(g.gold).toBe(40);
        expect(store.bounties()).toEqual([{ name: 'Bob', amount: 60 }]);
        expect(store.news(0).map(({ text }) => text)).toEqual(["{yellow}Someone has put $60 on Bob's head."]);
        expect(heard).toEqual(['{lightred}Someone has put $60 on your head!']);
    });

    test('reading them', async () => {
        const { store, board } = setting();
        store.postBounty(2, 1, 60, 1);
        const { g, term } = scriptContext({
            steps: [
                ...READ,
                () => {
                    expect(screenText(term.screen)).toMatch(/Bob +\$60/);
                    return 'escape';
                },
            ],
        });
        await board(g);
        expect(term.remaining).toBe(0);
    });

    test.each([
        [['Nobody'], "There's no player by that name."],
        [['Ann'], "You can't put a price on your own head."],
        [['Bob', String(MIN_BOUNTY - 1)], `At least $${MIN_BOUNTY}, or it isn't worth the paper.`],
        [['Bob', '1000'], "You haven't that much."],
    ])('refused: %p', async (answers, message) => {
        const { store, board } = setting();
        const { g, term } = scriptContext({ player: newPlayer({ gold: 100 }), steps: [...POST, ...answers.flatMap((a) => typed(a)), 'x'] });
        await board(g);
        expect(screenText(term.screen)).toContain(message);
        expect(g.gold).toBe(100);
        expect(store.bounties()).toEqual([]);
    });

    test('it hangs in town: not elsewhere', async () => {
        const { board } = setting();
        const { g, term } = scriptContext({ player: newPlayer({ screen: 2 }) });
        await board(g);
        expect(screenText(term.screen)).toContain('The bounty board hangs in town.');
    });
});

test('whoever beats a player in a fight collects the bounties on their head', async () => {
    const store = new Store(':memory:');
    store.createAccount('Ann', 'h', 'a@example.com');
    store.createAccount('Bob', 'h', 'b@example.com');
    store.postBounty(2, 3, 300, 1);
    const realm = new Realm<TestFlags, TestWorld>();
    const days = new Days({ store, content, realm, now: () => 1 });
    const bob = makeGame({ player: newPlayer({ gold: 0, hp: 5 }) }).game;
    Object.defineProperty(bob, 'waiting', { get: () => true });
    bob.notify = () => undefined;
    realm.claim(2, 'Bob');
    realm.attach(2, bob);
    realm.moved(2, { screen: 2, x: 11, y: 10 });
    realm.claim(1, 'Ann');
    realm.moved(1, { screen: 2, x: 10, y: 10 });
    random = spyOn(Math, 'random').mockReturnValue(0.99);
    const h = attack({ realm, store, days, world: testWorld(), items: itemCatalogue, me: { id: 1, name: 'Ann' }, now: () => 1 });
    const { g } = scriptContext({ player: newPlayer({ gold: 10 }), steps: ['enter', 'enter', 'x', 'x'] });
    await h(g);
    expect(g.gold).toBe(310);
    expect(store.bounties()).toEqual([]);
    expect(store.news(0).map(({ text }) => text)).toContain("{yellow}Ann collected the $300 bounty on Bob's head.");
});
