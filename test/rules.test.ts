// The game rules a server can change: each one is used where it matters.

import { expect, test } from 'bun:test';
import { DEFAULT_RULES, RULE_OPTIONS } from '../src/rules.ts';
import { Realm } from '../src/realm.ts';
import { Store } from '../src/store.ts';
import { asMonster } from '../src/pvp.ts';
import { mail } from '../src/talk.ts';
import { itemCatalogue, newPlayer, scriptContext, type TestFlags, type TestWorld } from '@fq2ts/engine/fixture';
import { pick, screenText, typed } from '@fq2ts/engine/testing';

test('every rule has a command line option, and the defaults are as they were', () => {
    const rules: string[] = RULE_OPTIONS.map(({ rule }) => rule);
    expect(rules.sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
    expect(DEFAULT_RULES).toEqual({
        fightsPerDay: 3,
        pvpGoldPercent: 50,
        pvpExpPercent: 10,
        chatWaitSeconds: 1,
        lettersPerVisit: 10,
        mailbox: 50,
        newsDays: 7,
        emailsPerVisit: 5,
        unfinishedAccountDays: 7,
        connectionsPerMinute: 20,
        loginFailuresPerAddress: 10,
        loginFailuresPerAccount: 20,
        lockoutMinutes: 15,
        signUpsPerAddressPerHour: 5,
        emailsPerAddressPerHour: 10,
        emailsPerRecipientPerHour: 3,
    });
});

test('the shares of gold and experience a fight between players is for', () => {
    const player = newPlayer({ gold: 200, exp: 1000 });
    expect(asMonster('Bob', player, itemCatalogue, { goldPercent: 25, expPercent: 50 })).toMatchObject({ gold: 50, exp: 500 });
    expect(asMonster('Bob', player, itemCatalogue, { goldPercent: 0, expPercent: 0 })).toMatchObject({ gold: 0, exp: 1 });
});

test('the chat wait', () => {
    let now = 0;
    const realm = new Realm<TestFlags, TestWorld>({ now: () => now, chatWait: 5000 });
    expect(realm.maySpeak(1)).toBe(true);
    now = 4999;
    expect(realm.maySpeak(1)).toBe(false);
    now = 5000;
    expect(realm.maySpeak(1)).toBe(true);
    const chatty = new Realm<TestFlags, TestWorld>({ chatWait: 0 });
    expect([chatty.maySpeak(1), chatty.maySpeak(1)]).toEqual([true, true]);
});

test("the mailbox's size and the news's days", () => {
    const store = new Store(':memory:', { mailbox: 2, newsDays: 1 });
    store.createAccount('Ann', 'h', 'a@example.com');
    for (const text of ['one', 'two', 'three']) {
        store.sendLetter(1, 'Bob', text, text.length);
    }
    expect(store.letters(1).map(({ text }) => text)).toEqual(['three', 'two']);
    store.addNews('old', 0);
    store.addNews('new', 86_400_001);
    expect(store.news(0).map(({ text }) => text)).toEqual(['new']);
});

test('letters a visit can send', async () => {
    const store = new Store(':memory:');
    store.createAccount('Ann', 'h', 'a@example.com');
    store.createAccount('Bob', 'h', 'b@example.com');
    const w = mail({ realm: new Realm<TestFlags, TestWorld>(), store, me: { id: 1, name: 'Ann' }, lettersPerVisit: 1 });
    await w(scriptContext({ steps: [...pick(1), ...typed('Bob'), ...typed('Hi'), 'enter', 'x'] }).g);
    const { g, term } = scriptContext({ steps: [...pick(1), 'x'] });
    await w(g);
    expect(screenText(term.screen)).toContain("That's all the letters for this visit.");
});
