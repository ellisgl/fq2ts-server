import { describe, expect, test } from 'bun:test';
import { BountyHunters, HUNTER_ODDS } from '../src/hunters.ts';
import { Store } from '../src/store.ts';
import { itemCatalogue, newPlayer, testWorld } from '@fq2ts/engine/fixture';

// Ann (1), with $30 on her head from Bob (2), and hunters whose every roll
// is `roll`.
function setUp(roll = 0, { bounty = 30 } = {}) {
    const store = new Store(':memory:');
    store.createAccount('Ann', 'h', 'a@example.com');
    store.createAccount('Bob', 'h', 'b@example.com');
    if (bounty) {
        store.postBounty(1, 2, bounty, 0);
    }
    const world = testWorld();
    const hunters = new BountyHunters({ store, world, items: itemCatalogue, random: () => roll });
    return { store, world, hunters };
}

describe('bounty hunters', () => {
    test("come for a player with a price on their head: made from the player's own stats", () => {
        const { hunters } = setUp(0);
        const hunter = hunters.ambush(1, newPlayer({ maxHp: 100, strength: 20, defense: 10 }));
        expect(hunter).toMatchObject({ name: 'Kael the Tracker', pronoun: 'he', hp: 80, defense: 8, gold: 20, attacks: [{ power: 16 }] });
    });

    test(`only 1 step in ${HUNTER_ODDS}, never on safe screens, and not for those with no bounty`, () => {
        expect(setUp(0.5).hunters.ambush(1, newPlayer())).toBeNull();
        const safe = setUp(0);
        safe.world.setSafe(1, true);
        expect(safe.hunters.ambush(1, newPlayer({ screen: 1 }))).toBeNull();
        expect(setUp(0, { bounty: 0 }).hunters.ambush(1, newPlayer())).toBeNull();
        const { store } = setUp(0);
        expect(new BountyHunters({ store, world: testWorld(), items: itemCatalogue, odds: 0, random: () => 0 }).ambush(1, newPlayer())).toBeNull();
    });

    test('a hunter who wins collects the bounty; one beaten leaves it; the news has both', () => {
        const { store, hunters } = setUp(0);
        const caught = hunters.ambush(1, newPlayer());
        if (!caught) {
            throw new Error('No hunter came.');
        }
        expect(hunters.fought(1, 'Ann', caught, 'lost', 5)).toBe('{lightred}Kael the Tracker collects the $30 bounty on your head.');
        expect(store.bountyOn(1)).toBe(0);
        expect(store.news(0).map(({ text }) => text)).toEqual(['{lightred}Kael the Tracker caught Ann, and collected the $30 bounty on their head.']);
        // (Told once: the same fight isn't a hunter's again.)
        expect(hunters.fought(1, 'Ann', caught, 'lost', 6)).toBeNull();

        store.postBounty(1, 2, 50, 7);
        const beaten = hunters.ambush(1, newPlayer());
        if (!beaten) {
            throw new Error('No hunter came.');
        }
        expect(hunters.fought(1, 'Ann', beaten, 'won', 8)).toContain('the price on your head stands');
        expect(store.bountyOn(1)).toBe(50);
        expect(store.news(0)[0]?.text).toBe('{lightgreen}Ann fought off Kael the Tracker, a bounty hunter.');
    });

    test("any other fight isn't theirs", () => {
        const { hunters } = setUp(0);
        expect(hunters.fought(1, 'Ann', { name: 'Blob', says: '', pronoun: 'it', hp: 1, defense: 0, gold: 0, exp: 0, attacks: [], kill: '', after: {} }, 'lost', 0)).toBeNull();
    });
});
