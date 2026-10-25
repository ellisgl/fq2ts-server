import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { MAX_EMAILS, RESEND_WAIT, Session } from '../../server/session.ts';
import { Store } from '../../server/store.ts';
import type { Email } from '../../server/mail.ts';
import { Game } from '../../engine/game.ts';
import content from '../../content/index.ts';
import { bestiary, config, FakeTerminal, gameWorld, itemCatalogue, newPlayer, pick, row, screenText, tempDir, typed, type Step } from '../helpers.ts';

// Quick stand-ins for argon2 (the real thing takes a moment per call).
const hashPassword = (password: string): Promise<string> => Promise.resolve(`hash:${password}`);
const verifyPassword = (password: string, hash: string): Promise<boolean> => Promise.resolve(hash === `hash:${password}`);

interface Setup {
    store?: Store;
    claim?(id: number): boolean;
    broken?: boolean;
    mailFails?: boolean;
}

// The emails sent in this test, and the time it is (moved on by tests).
let sent: Email[] = [];
let clock = 0;

function session(steps: Steps, { store = new Store(':memory:'), claim = () => true, broken = false, mailFails = false }: Setup = {}) {
    const term = new FakeTerminal();
    const logs: string[] = [];
    const released: number[] = [];
    sent = [];
    clock = 1_000_000;
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
        mailer: {
            send: (email) => {
                if (mailFails) {
                    return Promise.reject(new Error('No mail server.'));
                }

                sent.push(email);
                return Promise.resolve();
            },
        },
        now: () => clock,
        hashPassword,
        verifyPassword,
    });
    term.feed(...(typeof steps === 'function' ? steps(term) : steps));
    return { run, term, store, logs, released };
}

type Steps = readonly Step[] | ((term: FakeTerminal) => readonly Step[]);

const LOG_IN = pick(0);
const NEW_PLAYER = pick(1);
const FORGOT = pick(2);
const LEAVE = 'escape';
// From the map: Escape, then "Leave the realm".
const LEAVE_THE_REALM = ['escape', ...pick(1)];
// A new game's opening: "A man", then past the scene.
const OPENING = ['enter', 'x'];

// The code in the last email, typed in (read when it's typed, as it's only
// sent part way through a test).
const lastCode = (): string => /your code is (\d+)/.exec(sent.at(-1)?.subject ?? '')?.[1] ?? '';
const CODE: Step[] = [...Array.from({ length: 6 }, (_, i) => () => lastCode().charAt(i)), 'enter'];
const EMAIL = typed('hero@example.com');
// The code prompt's options, after Escape.
const SEND_AGAIN = pick(1);
const CHANGE_EMAIL = pick(2);
const NOT_NOW = 'escape';

// An account with a confirmed email address.
function account(store: Store, name = 'Hero', password = 'secret1'): number {
    const id = store.createAccount(name, `hash:${password}`, `${name.toLowerCase()}@example.com`)?.id ?? 0;
    store.confirmEmail(id);
    return id;
}

describe('the front door', () => {
    test('shows the title screen with its menu in the box', async () => {
        const { run, term } = session((t) => [
            () => {
                expect(screenText(t.screen)).toContain('V0.94 Rev D');
                expect(row(t.screen, 17)).toContain('Log in');
                expect(row(t.screen, 18)).toContain('New player');
                expect(row(t.screen, 19)).toContain('Forgot password');
                expect(row(t.screen, 20)).toContain('Leave this place');
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
            ...EMAIL,
            () => {
                expect(row(t.screen, 25).trim()).toBe('We emailed a code to hero@example.com.');
                return lastCode().charAt(0);
            },
            ...CODE.slice(1),
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
        expect(store.account('hero')).toMatchObject({ passwordHash: 'hash:secret1', email: 'hero@example.com', emailConfirmed: true });
        expect(store.loadPlayer(1)).toMatchObject({ name: 'Hero', screen: 721, x: 34, weapon: 'stick' });
        expect(logs).toEqual(['New account: Hero', 'Hero confirmed their email address.', 'Hero enters the realm.', 'Hero leaves the realm.']);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ to: 'hero@example.com' });
        expect(sent[0]?.text).toContain(`Your code is ${lastCode()}.`);
        expect(lastCode()).toMatch(/^\d{6}$/);
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
                    ...typed('not an address'),
                    says("That doesn't look like an email address."),
                    ...typed('fresh@example.com'),
                    ...CODE,
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
                ...EMAIL,
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

describe('email addresses', () => {
    test('a wrong code is turned down, and the right one still works', async () => {
        const { run, store, term } = session((t) => [
            ...NEW_PLAYER,
            ...typed('Hero'),
            ...typed('secret1'),
            ...typed('secret1'),
            ...EMAIL,
            ...typed('000000'),
            () => {
                expect(row(t.screen, 25).trim()).toBe("That isn't the code.");
                return 'x';
            },
            ...CODE,
            ...OPENING,
            ...LEAVE_THE_REALM,
            LEAVE,
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.emailConfirmed).toBe(true);
    });

    test('"Not now" keeps the account; logging in asks for the same code', async () => {
        const store = new Store(':memory:');
        const { run, term } = session(
            [...NEW_PLAYER, ...typed('Hero'), ...typed('secret1'), ...typed('secret1'), ...EMAIL, 'escape', NOT_NOW, ...LOG_IN, ...typed('hero'), ...typed('secret1'), ...CODE, ...OPENING, ...LEAVE_THE_REALM, LEAVE],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(sent).toHaveLength(1);
        expect(store.account('hero')?.emailConfirmed).toBe(true);
    });

    test('a new code: not straight away, then in place of the old one', async () => {
        const store = new Store(':memory:');
        let first = '';
        const { run, term } = session(
            (t) => [
                ...NEW_PLAYER,
                ...typed('Hero'),
                ...typed('secret1'),
                ...typed('secret1'),
                ...EMAIL,
                'escape',
                ...SEND_AGAIN,
                () => {
                    expect(row(t.screen, 25).trim()).toBe('A code was sent a moment ago. Please use that one.');
                    first = lastCode();
                    clock += RESEND_WAIT;
                    return 'escape';
                },
                'escape',
                ...SEND_AGAIN,
                // The old code, which no longer works.
                ...Array.from({ length: 6 }, (_, i) => () => first.charAt(i)),
                'enter',
                () => {
                    expect(sent).toHaveLength(2);
                    expect(row(t.screen, 25).trim()).toBe("That isn't the code.");
                    return 'x';
                },
                ...CODE,
                ...OPENING,
                ...LEAVE_THE_REALM,
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
    });

    test('the address can be changed before it is confirmed', async () => {
        const { run, store, term } = session([
            ...NEW_PLAYER,
            ...typed('Hero'),
            ...typed('secret1'),
            ...typed('secret1'),
            ...typed('typo@exmaple.com'),
            'escape',
            ...CHANGE_EMAIL,
            ...EMAIL,
            ...CODE,
            ...OPENING,
            ...LEAVE_THE_REALM,
            LEAVE,
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
        expect(sent.map((e) => e.to)).toEqual(['typo@exmaple.com', 'hero@example.com']);
        expect(store.account('hero')).toMatchObject({ email: 'hero@example.com', emailConfirmed: true });
    });

    test('an account from before email addresses is asked for one', async () => {
        const path = join(tempDir(), 'old.sqlite');
        const old = new Database(path, { create: true });
        old.run('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT)');
        old.run("INSERT INTO accounts (name, password_hash, created_at) VALUES ('Hero', 'hash:secret1', 'then')");
        old.close();
        const store = new Store(path);
        const { run, term } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('secret1'),
                ...EMAIL,
                ...CODE,
                () => {
                    expect(screenText(t.screen)).toContain('And are you');
                    return 'enter';
                },
                'x',
                ...LEAVE_THE_REALM,
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')).toMatchObject({ email: 'hero@example.com', emailConfirmed: true });
    });

    test("an email that can't be sent is logged, and the player told", async () => {
        const { run, logs, term } = session(
            (t) => [
                ...NEW_PLAYER,
                ...typed('Hero'),
                ...typed('secret1'),
                ...typed('secret1'),
                ...EMAIL,
                () => {
                    expect(row(t.screen, 25).trim()).toBe("The email couldn't be sent. Please try later.");
                    return 'x';
                },
                NOT_NOW,
                LEAVE,
            ],
            { mailFails: true },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(logs).toContain("Couldn't email Hero: No mail server.");
    });

    test(`one visit can only ask for ${MAX_EMAILS} emails`, async () => {
        // A minute later, another.
        const again = (): Step[] => [
            () => {
                clock += RESEND_WAIT;
                return 'escape';
            },
            ...SEND_AGAIN,
        ];
        const { run, term } = session((t) => [
            ...NEW_PLAYER,
            ...typed('Hero'),
            ...typed('secret1'),
            ...typed('secret1'),
            ...EMAIL,
            ...Array.from({ length: MAX_EMAILS }, again).flat(),
            () => {
                expect(row(t.screen, 25).trim()).toBe("That's all the emails for this visit.");
                return 'x';
            },
            NOT_NOW,
            LEAVE,
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
        expect(sent).toHaveLength(MAX_EMAILS);
    });
});

describe('forgotten passwords', () => {
    test('a code by email, then a new password', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, logs, term } = session(
            (t) => [
                ...FORGOT,
                ...typed('hero'),
                ...CODE,
                ...typed('newpass'),
                ...typed('newpass'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('Your password is changed. Log in with it now.');
                    return 'x';
                },
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.passwordHash).toBe('hash:newpass');
        expect(sent[0]).toMatchObject({ to: 'hero@example.com' });
        expect(sent[0]?.text).toContain("reset the password of Hero's account");
        expect(logs).toEqual(['Hero reset their password.']);
    });

    test('only for accounts with a confirmed address', async () => {
        const store = new Store(':memory:');
        store.createAccount('Unsure', 'hash:secret1', 'unsure@example.com');
        const says = (t: FakeTerminal): Step => () => {
            expect(row(t.screen, 25).trim()).toBe('There is no account by that name with a confirmed email.');
            return 'x';
        };
        const { run, term } = session((t) => [...FORGOT, ...typed('nobody'), says(t), ...FORGOT, ...typed('unsure'), says(t), LEAVE], { store });
        await run.run();
        expect(term.remaining).toBe(0);
        expect(sent).toEqual([]);
    });

    test('Escape at the code leaves the password as it was', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, term } = session([...FORGOT, ...typed('hero'), 'escape', LEAVE], { store });
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.passwordHash).toBe('hash:secret1');
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
