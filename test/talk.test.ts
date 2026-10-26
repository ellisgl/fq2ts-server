import { describe, expect, spyOn, test } from 'bun:test';
import { CHAT_WAIT, Realm } from '../src/realm.ts';
import { LETTERS_PER_VISIT, lostFight, mail, news, talk, yell } from '../src/talk.ts';
import { MAILBOX, NEWS_DAYS, Store } from '../src/store.ts';
import { makeGame, scriptContext, type TestFlags } from '@fq2ts/engine/fixture';
import { monster, pick, screenText, typed } from '@fq2ts/engine/testing';

const DAY = 86_400_000;

// A realm on a clock the test moves, with Ann (1) and Bob (2) on screen 1
// and Cat (3) on screen 2; their games' notices are kept.
function realm() {
    let now = 1_000_000;
    const r = new Realm<TestFlags>({ now: () => now });
    const heard: Record<string, string[]> = {};
    for (const [id, name, screen] of [[1, 'Ann', 1], [2, 'Bob', 1], [3, 'Cat', 2]] as const) {
        const { game } = makeGame();
        heard[name] = [];
        spyOn(game, 'notify').mockImplementation((text) => {
            heard[name]?.push(text);
        });
        r.claim(id, name);
        r.attach(id, game);
        r.moved(id, { screen, x: 10, y: 10 });
    }
    for (const list of Object.values(heard)) {
        list.length = 0;
    }
    return { realm: r, heard, later: (ms: number) => (now += ms) };
}

// A store with accounts for Ann (1), Bob (2) and Cat (3).
function store(): Store {
    const s = new Store(':memory:');
    for (const name of ['Ann', 'Bob', 'Cat']) {
        s.createAccount(name, 'h', `${name.toLowerCase()}@example.com`);
    }
    return s;
}

describe('the store: letters and news', () => {
    test('letters are kept newest first, and counted until read', () => {
        const s = store();
        s.sendLetter(1, 'Bob', 'First', 100);
        s.sendLetter(1, 'Cat', 'Second\nline two', 200);
        expect(s.unreadLetters(1)).toBe(2);
        expect(s.letters(1).map(({ from, text, read }) => [from, text, read])).toEqual([
            ['Cat', 'Second\nline two', false],
            ['Bob', 'First', false],
        ]);
        s.markLettersRead(1);
        expect(s.unreadLetters(1)).toBe(0);
        expect(s.letters(2)).toEqual([]);
    });

    test(`a mailbox keeps the newest ${MAILBOX}`, () => {
        const s = store();
        for (let i = 0; i < MAILBOX + 5; i++) {
            s.sendLetter(1, 'Bob', `Letter ${i}`, i);
        }
        const letters = s.letters(1);
        expect(letters).toHaveLength(MAILBOX);
        expect(letters.at(-1)?.text).toBe('Letter 5');
    });

    test(`news is kept for ${NEWS_DAYS} days`, () => {
        const s = store();
        s.addNews('Old', 0);
        s.addNews('Recent', DAY);
        s.addNews('New', NEWS_DAYS * DAY + 1);
        expect(s.news(0).map(({ text }) => text)).toEqual(['New', 'Recent']);
        expect(s.news(2 * DAY).map(({ text }) => text)).toEqual(['New']);
    });
});

describe('the realm: talking', () => {
    test('toScreen tells the others on the screen, and says how many heard', () => {
        const { realm: r, heard } = realm();
        expect(r.toScreen(1, 'hi')).toBe(1);
        expect(heard).toEqual({ Ann: [], Bob: ['hi'], Cat: [] });
        expect(r.toScreen(3, 'anyone?')).toBe(0);
    });

    test('toEveryone tells everyone else; toMember one member, if they are in', () => {
        const { realm: r, heard } = realm();
        r.toEveryone(1, 'HELLO');
        expect(heard).toEqual({ Ann: [], Bob: ['HELLO'], Cat: ['HELLO'] });
        expect(r.toMember(3, 'post')).toBe(true);
        expect(heard['Cat']).toEqual(['HELLO', 'post']);
        expect(r.toMember(99, 'post')).toBe(false);
    });

    test(`a member can speak once every ${CHAT_WAIT} ms`, () => {
        const { realm: r, later } = realm();
        expect(r.maySpeak(1)).toBe(true);
        expect(r.maySpeak(1)).toBe(false);
        expect(r.maySpeak(2)).toBe(true);
        later(CHAT_WAIT);
        expect(r.maySpeak(1)).toBe(true);
    });
});

describe('T and Y', () => {
    test('T says it to the screen, escaped; the speaker sees what they said', async () => {
        const { realm: r, heard } = realm();
        const { g, term } = scriptContext({ steps: [...typed('hi {red}there')] });
        await talk({ realm: r, store: store(), me: { id: 1, name: 'Ann' } })(g);
        expect(heard['Bob']).toEqual(['{white}Ann says: {gray}"hi {{red}there"']);
        expect(screenText(term.screen)).toContain('You say: "hi {red}there"');
    });

    test('T with no one about, too soon, or nothing to say', async () => {
        const { realm: r, heard } = realm();
        const me = { id: 3, name: 'Cat' };
        const alone = scriptContext({ steps: [...typed('echo')] });
        await talk({ realm: r, store: store(), me })(alone.g);
        expect(screenText(alone.term.screen)).toContain('but no one is here to hear it.');

        const soon = scriptContext({ steps: [...typed('again')] });
        await talk({ realm: r, store: store(), me })(soon.g);
        expect(screenText(soon.term.screen)).toContain('Not so fast!');

        const quiet = scriptContext({ steps: ['escape'] });
        await talk({ realm: r, store: store(), me: { id: 1, name: 'Ann' } })(quiet.g);
        expect(heard['Bob']).toEqual([]);
    });

    test('Y tells everyone in the realm', async () => {
        const { realm: r, heard } = realm();
        const { g, term } = scriptContext({ steps: [...typed('Dinner!')] });
        await yell({ realm: r, store: store(), me: { id: 1, name: 'Ann' } })(g);
        expect(heard['Bob']).toEqual(['{yellow}Ann yells: "Dinner!"']);
        expect(heard['Cat']).toEqual(['{yellow}Ann yells: "Dinner!"']);
        expect(screenText(term.screen)).toContain('You yell: "Dinner!"');
    });
});

describe('W', () => {
    const READ = pick(0);
    const WRITE = pick(1);

    test('writes a letter (to any player, in any case); they hear of it, and read it', async () => {
        const { realm: r, heard } = realm();
        const s = store();
        const ann = { realm: r, store: s, me: { id: 1, name: 'Ann' }, now: () => 5 };
        const { g, term } = scriptContext({ steps: [...WRITE, ...typed('bob'), ...typed('Hello Bob,'), ...typed('see you {soon}.'), 'enter', 'x'] });
        await mail(ann)(g);
        expect(screenText(term.screen)).toContain('Your letter is on its way.');
        expect(s.letters(2)).toEqual([{ id: 1, from: 'Ann', text: 'Hello Bob,\nsee you {soon}.', sentAt: 5, read: false }]);
        expect(heard['Bob']).toEqual(['{lightgreen}A letter from Ann has come. (W to read it.)']);

        const bob = scriptContext({
            steps: [
                ...READ,
                () => {
                    const text = screenText(bob.term.screen);
                    expect(text).toContain('From Ann');
                    expect(text).toContain('(new)');
                    expect(text).toContain('see you {soon}.');
                    return 'escape';
                },
            ],
        });
        await mail({ realm: r, store: s, me: { id: 2, name: 'Bob' } })(bob.g);
        expect(s.unreadLetters(2)).toBe(0);
    });

    test('no one by that name, yourself, an empty letter and Escape send nothing', async () => {
        const { realm: r } = realm();
        const s = store();
        const ann = { realm: r, store: s, me: { id: 1, name: 'Ann' } };
        for (const steps of [
            [...WRITE, ...typed('Nobody'), 'x'],
            [...WRITE, ...typed('ann'), 'x'],
            [...WRITE, ...typed('Bob'), 'enter'],
            [...WRITE, ...typed('Bob'), ...typed('Dear Bob'), 'escape'],
            [...WRITE, 'escape'],
        ]) {
            const { g, term } = scriptContext({ steps });
            await mail(ann)(g);
            expect(term.remaining).toBe(0);
        }
        expect(s.letters(2)).toEqual([]);
    });

    test(`one visit can send ${LETTERS_PER_VISIT} letters`, async () => {
        const { realm: r } = realm();
        const s = store();
        const w = mail({ realm: r, store: s, me: { id: 1, name: 'Ann' } });
        for (let i = 0; i < LETTERS_PER_VISIT; i++) {
            await w(scriptContext({ steps: [...WRITE, ...typed('Bob'), ...typed(`No. ${i}`), 'enter', 'x'] }).g);
        }
        const { g, term } = scriptContext({ steps: [...WRITE, 'x'] });
        await w(g);
        expect(screenText(term.screen)).toContain("That's all the letters for this visit.");
        expect(s.letters(2)).toHaveLength(LETTERS_PER_VISIT);
    });
});

describe('D and the news', () => {
    test("shows today's and yesterday's news, newest first", async () => {
        const s = store();
        const today = new Date(2026, 9, 25, 12, 0).getTime();
        s.addNews('Ann has come to the realm.', today - 2 * 3_600_000);
        s.addNews('{lightred}Ann was beaten by a Bear.', today - 3_600_000);
        s.addNews('Bob has come to the realm.', today - 20 * 3_600_000);
        s.addNews('Too old.', today - 3 * 86_400_000);
        const { realm: r } = realm();
        const { g, term } = scriptContext({
            steps: [
                () => {
                    const lines = screenText(term.screen).split('\n').map((line) => line.trim()).filter(Boolean);
                    const start = lines.indexOf('Today');
                    expect(lines.slice(start, start + 5)).toEqual(['Today', '11:00  Ann was beaten by a Bear.', '10:00  Ann has come to the realm.', 'Yesterday', '16:00  Bob has come to the realm.']);
                    return 'escape';
                },
            ],
        });
        await news({ realm: r, store: s, me: { id: 1, name: 'Ann' }, now: () => today })(g);
        expect(term.remaining).toBe(0);
    });

    test('lostFight names the monster as it should', () => {
        expect(lostFight('Ann', monster({ name: 'Bear' }))).toBe('{lightred}Ann was beaten by a Bear.');
        expect(lostFight('Ann', monster({ name: 'Owl' }))).toBe('{lightred}Ann was beaten by an Owl.');
        expect(lostFight('Ann', monster({ name: 'Master Roshi', pronoun: 'he' }))).toBe('{lightred}Ann was beaten by Master Roshi.');
        expect(lostFight('{red}X', monster({ name: 'Bear' }))).toBe('{lightred}{{red}X was beaten by a Bear.');
    });
});
