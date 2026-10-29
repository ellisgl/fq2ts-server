import { describe, expect, spyOn, test } from 'bun:test';
import { INN_COST, inn } from '../src/inn.ts';
import { newPlayer, scriptContext, testWorld, type TestFlags } from '@fq2ts/engine/fixture';
import { screenText } from '@fq2ts/engine/testing';

describe('inns (Z)', () => {
    // An inn on screen 1, and whether the player went to sleep.
    function setUp(steps: string[], gold = 100, screen = 1) {
        const world = testWorld();
        world.setInn(1, true);
        let slept = false;
        const z = inn<TestFlags>({
            world,
            sleep: () => {
                slept = true;
            },
        });
        const context = scriptContext({ player: newPlayer({ gold, screen }), steps });
        return { z, ...context, slept: () => slept };
    }

    test('a room is paid for, and the player goes to sleep', async () => {
        const { z, g, term, slept } = setUp(['enter']);
        await z(g);
        expect(term.remaining).toBe(0);
        expect(g.gold).toBe(100 - INN_COST);
        expect(slept()).toBe(true);
    });

    test('not now, not without the money, and not where there is no inn', async () => {
        const notNow = setUp(['down', 'enter']);
        await notNow.z(notNow.g);
        expect([notNow.g.gold, notNow.slept()]).toEqual([100, false]);

        const poor = setUp(['enter', 'x'], INN_COST - 1);
        await poor.z(poor.g);
        expect(screenText(poor.term.screen)).toContain("You can't afford a room.");
        expect([poor.g.gold, poor.slept()]).toEqual([INN_COST - 1, false]);

        const nowhere = setUp([], 100, 2);
        await nowhere.z(nowhere.g);
        expect(nowhere.slept()).toBe(false);
    });

    test('at home, there is no need for a room: no charge', async () => {
        const world = testWorld();
        world.setHome(1, true);
        let slept = false;
        const z = inn<TestFlags>({
            world,
            sleep: () => {
                slept = true;
            },
        });
        const { g } = scriptContext({ player: newPlayer({ gold: 100, screen: 1 }) });
        const write = spyOn(g, 'write');
        await z(g);
        expect([g.gold, slept]).toEqual([100, false]);
        expect(write).toHaveBeenCalledWith("{lightgreen}You're home: no need for a room. Leave the realm here, and you'll sleep safely in your own bed.");
    });

    test('what a room costs is the server\'s to say', async () => {
        const world = testWorld();
        world.setInn(1, true);
        const z = inn<TestFlags>({ world, cost: 5, sleep: () => undefined });
        const { g } = scriptContext({ player: newPlayer({ gold: 7, screen: 1 }), steps: ['enter'] });
        await z(g);
        expect(g.gold).toBe(2);
    });
});
