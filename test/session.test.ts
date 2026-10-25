import { describe, expect, test } from 'bun:test';
import { Session } from '../../server/session.ts';
import { Store } from '../../server/store.ts';
import { Game } from '../../engine/game.ts';
import content from '../../content/index.ts';
import { bestiary, config, FakeTerminal, gameWorld, itemCatalogue, newPlayer, pick, row, screenText, typed, type Step } from '../helpers.ts';

// Quick stand-ins for argon2 (the real thing takes a moment per call).
const hashPassword = (password: string): Promise<string> => Promise.resolve(`hash:${password}`);
const verifyPassword = (password: string, hash: string): Promise<boolean> => Promise.resolve(hash === `hash:${password}`);

interface Setup {
    store?: Store;
    claim?(id: number): boolean;
    broken?: boolean;
}

function session(steps: Steps, { store = new Store(':memory:'), claim = () => true, broken = false }: Setup = {}) {
    const term = new FakeTerminal();
    const logs: string[] = [];
    const released: number[] = [];
    const run = new Session({
        term,
        store,
        content,
        items: itemCatalogue,
        config,
        makeGame: (autosave) => {
            if (broken) {
                throw new Error('The game is broken.');
            }

            return new Game({ term, world: gameWorld(), config, monsters: bestiary, items: itemCatalogue, content, autosave, screensaver: false });
        },
        claim,
        release: (id) => released.push(id),
        log: (line) => logs.push(line),
        hashPassword,
        verifyPassword,
    });
    term.feed(...(typeof steps === 'function' ? steps(term) : steps));
    return { run, term, store, logs, released };
}

type Steps = readonly Step[] | ((term: FakeTerminal) => readonly Step[]);

const LOG_IN = pick(0);
const NEW_PLAYER = pick(1);
const LEAVE = 'escape';
// From the map: Escape, then "Leave the realm".
const LEAVE_THE_REALM = ['escape', ...pick(1)];
// A new game's opening: "A man", then past the scene.
const OPENING = ['enter', 'x'];

function account(store: Store, name = 'Hero', password = 'secret1'): number {
    return store.createAccount(name, `hash:${password}`)?.id ?? 0;
}

describe('the front door', () => {
    test('shows the title screen with its menu in the box', async () => {
        const { run, term } = session((t) => [
            () => {
                expect(screenText(t.screen)).toContain('V0.94 Rev D');
                expect(row(t.screen, 17)).toContain('Log in');
                expect(row(t.screen, 18)).toContain('New player');
                expect(row(t.screen, 19)).toContain('Leave this place');
                expect(t.screen.cell(33, 17)).toMatchObject({ fg: 11, bg: 1 });
                expect(t.screen.cell(33, 18)).toMatchObject({ fg: 9, bg: 1 });
                return LEAVE;
            },
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
    });
});

describe('new players', () => {
    test('make an account, play a new game, and are saved', async () => {
        const { run, store, logs, term } = session((t) => [
            ...NEW_PLAYER,
            ...typed('Hero'),
            ...typed('secret1'),
            ...typed('secret1'),
            () => {
                // The game knows the name already, so it only asks the sex.
                expect(screenText(t.screen)).not.toContain('What is your name');
                expect(row(t.screen, 6)).toBe('And are you...');
                return 'enter';
            },
            'x',
            'right',
            ...LEAVE_THE_REALM,
            LEAVE,
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.passwordHash).toBe('hash:secret1');
        expect(store.loadPlayer(1)).toMatchObject({ name: 'Hero', screen: 721, x: 34, weapon: 'stick' });
        expect(logs).toEqual(['New account: Hero', 'Hero enters the realm.', 'Hero leaves the realm.']);
    });

    test('names must be valid and free; passwords long enough and typed the same twice', async () => {
        const store = new Store(':memory:');
        account(store, 'Taken');
        const { run, term } = session(
            (t) => {
                const says = (text: string): Step => () => {
                    expect(row(t.screen, 25).trim()).toBe(text);
                    return 'x';
                };
                return [
                    ...NEW_PLAYER,
                    ...typed('{red}Bob'),
                    says("2-20 letters, digits, spaces and ' - . please."),
                    ...typed('taken'),
                    says('Someone already has that name.'),
                    ...typed('Fresh'),
                    ...typed('short'),
                    ...typed('short'),
                    says('At least 6 characters, please.'),
                    ...typed('secret1'),
                    ...typed('secret2'),
                    says("Those weren't the same."),
                    ...typed('secret1'),
                    ...typed('secret1'),
                    ...OPENING,
                    ...LEAVE_THE_REALM,
                    LEAVE,
                ];
            },
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('fresh')).not.toBeNull();
    });

    test('passwords are hidden as they are typed', async () => {
        const { run } = session((t) => [
            ...NEW_PLAYER,
            ...typed('Hero'),
            ...'abc',
            () => {
                expect(row(t.screen, 20)).toContain('***');
                expect(screenText(t.screen)).not.toContain('abc');
                return 'escape';
            },
            LEAVE,
        ]);
        await run.run();
    });

    test('Escape at any question goes back to the menu', async () => {
        const { run, store } = session([...NEW_PLAYER, 'escape', ...NEW_PLAYER, ...typed('Hero'), 'escape', ...NEW_PLAYER, ...typed('Hero'), ...typed('secret1'), 'escape', LEAVE]);
        await run.run();
        expect(store.account('hero')).toBeNull();
    });

    test('a name taken while the player was typing', async () => {
        const store = new Store(':memory:');
        const { run, term } = session(
            (t) => [
                ...NEW_PLAYER,
                ...typed('Hero'),
                () => {
                    account(store);
                    return 's';
                },
                ...typed('ecret1'),
                ...typed('secret1'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('Someone just took that name. Try another.');
                    return 'x';
                },
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
    });
});

describe('logging in', () => {
    test('picks up where the player left off', async () => {
        const store = new Store(':memory:');
        const id = account(store);
        store.savePlayer(id, newPlayer({ name: 'Hero', screen: 82, x: 30, y: 10, gold: 77 }));
        const { run, logs } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('secret1'),
                () => {
                    expect(t.screen.cell(30, 10).ch).toBe('☺');
                    return 'escape';
                },
                // Back to the game, then out.
                ...pick(0),
                ...LEAVE_THE_REALM,
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(store.loadPlayer(id)).toMatchObject({ screen: 82, x: 30, gold: 77 });
        expect(logs).toEqual(['Hero enters the realm.', 'Hero leaves the realm.']);
    });

    test('a wrong name or password says so; three and the player is shown out', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, term } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('wrong'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('Wrong name or password.');
                    return 'x';
                },
                ...LOG_IN,
                ...typed('nobody'),
                ...typed('secret1'),
                'x',
                ...LOG_IN,
                ...typed('hero'),
                ...typed('nope'),
                'x',
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(row(term.screen, 25).trim()).toBe('Too many wrong passwords. Goodbye.');
    });

    test('Escape at the name or password goes back', async () => {
        const { run, term } = session([...LOG_IN, 'escape', ...LOG_IN, ...typed('hero'), 'escape', LEAVE]);
        await run.run();
        expect(term.remaining).toBe(0);
    });

    test('an account already playing elsewhere is turned away', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, released } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('secret1'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('You are already in the realm somewhere else.');
                    return 'x';
                },
                LEAVE,
            ],
            { store, claim: () => false },
        );
        await run.run();
        expect(released).toEqual([]);
    });
});

describe('when things go wrong', () => {
    test('a disconnect saves the player where they were', async () => {
        const store = new Store(':memory:');
        const id = account(store);
        const { run, released } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('secret1'),
                ...OPENING,
                'right',
                () => {
                    t.disconnect();
                    return 'right';
                },
            ],
            { store },
        );
        await run.run();
        expect(store.loadPlayer(id)).toMatchObject({ x: 35 });
        expect(released).toEqual([id]);
    });

    test('an error is logged, the player told, and the account released', async () => {
        const store = new Store(':memory:');
        const id = account(store);
        const { run, logs, released, term } = session([...LOG_IN, ...typed('hero'), ...typed('secret1')], { store, broken: true });
        await run.run();
        expect(logs.some((line) => line.startsWith('Session error: Error: The game is broken.'))).toBe(true);
        expect(row(term.screen, 25).trim()).toBe('Something went wrong. Sorry! Your game was saved.');
        expect(released).toEqual([id]);
    });

    test('save does nothing when no one is playing', () => {
        const { run } = session([]);
        expect(() => {
            run.save();
        }).not.toThrow();
    });
});
