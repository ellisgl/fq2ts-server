import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { MAX_EMAILS, RESEND_WAIT, Session } from '../src/session.ts';
import { Store } from '../src/store.ts';
import type { Email } from '../src/mail.ts';
import { Game } from '@fq2js/engine/game';
import { FakeTerminal, pick, row, screenText, tempDir, typed, type Step } from '@fq2js/engine/testing';
import { bestiary, config, content, itemCatalogue, newPlayer, testWorld } from '@fq2js/engine/fixture';

// Quick stand-ins for argon2 (the real thing takes a moment per call).
const hashPassword = (password: string): Promise<string> => Promise.resolve(`hash:${password}`);
const verifyPassword = (password: string, hash: string): Promise<boolean> => Promise.resolve(hash === `hash:${password}`);

interface Setup {
    store?: Store;
    claim?(id: number): boolean;
    broken?: boolean;
    // The game is made, but fails as it begins.
    brokenStart?: boolean;
    mailFails?: boolean;
}

// The emails sent in this test, and the time it is (moved on by tests).
let sent: Email[] = [];
let clock = 0;

function session(steps: Steps, { store = new Store(':memory:'), claim = () => true, broken = false, brokenStart = false, mailFails = false }: Setup = {}) {
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
        makeGame: (_account, autosave) => {
            if (broken) {
                throw new Error('The game is broken.');
            }

            const game = new Game({ term, world: testWorld(), config, monsters: bestiary, items: itemCatalogue, content, autosave, screensaver: false });
            if (brokenStart) {
                game.begin = () => Promise.reject(new Error('The game broke as it began.'));
            }

            return game;
        },
        claim: ({ id }) => claim(id),
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
const LEAVE_THE_REALM = ['escape', ...pick(2)];
// A new game's opening (Test Quest's: one screen, then a key).
const OPENING = ['x'];

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
                expect(screenText(t.screen)).toContain('V1.0 Rev A');
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
                expect(row(t.screen, 1)).toBe('A NEW GAME BEGINS');
                return 'x';
            },
            'right',
            ...LEAVE_THE_REALM,
            LEAVE,
        ]);
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')).toMatchObject({ passwordHash: 'hash:secret1', email: 'hero@example.com', emailConfirmed: true });
        expect(store.loadPlayer(1)).toMatchObject({ name: 'Hero', screen: 1, x: 11, y: 10 });
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
                ...typed('other@example.com'),
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
                    expect(row(t.screen, 1)).toBe('A NEW GAME BEGINS');
                    return 'x';
                },
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

describe('one address, one account', () => {
    test("a new player can't use an address another account has", async () => {
        const store = new Store(':memory:');
        account(store, 'Taken');
        const { run, term } = session(
            (t) => [
                ...NEW_PLAYER,
                ...typed('Hero'),
                ...typed('secret1'),
                ...typed('secret1'),
                ...typed('TAKEN@example.com'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('That email address already has an account.');
                    return 'x';
                },
                'escape',
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')).toBeNull();
        expect(sent).toEqual([]);
    });

    test('of two accounts waiting to confirm one address, the first to confirm it has it', async () => {
        const store = new Store(':memory:');
        const first = store.createAccount('First', 'hash:secret1', 'same@example.com')?.id ?? 0;
        const { run, term } = session(
            (t) => [
                ...NEW_PLAYER,
                ...typed('Hero'),
                ...typed('secret1'),
                ...typed('secret1'),
                ...typed('same@example.com'),
                () => {
                    store.confirmEmail(first);
                    return lastCode().charAt(0);
                },
                ...CODE.slice(1),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('That email address already has an account.');
                    return 'x';
                },
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.emailConfirmed).toBe(false);
    });
});

describe('changing email address', () => {
    // Logged in, past the opening, and on the menu from the map.
    const CHANGE = [...LOG_IN, ...typed('hero'), ...typed('secret1'), ...OPENING, 'escape', ...pick(1)];

    test('takes the password and a code sent to the new address; the old one is told', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, logs, term } = session(
            (t) => [
                ...CHANGE,
                ...typed('secret1'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('Now: hero@example.com');
                    return 'n';
                },
                ...typed('ew@example.com'),
                ...CODE,
                () => {
                    expect(row(t.screen, 25).trim()).toBe('Your email address is changed.');
                    return 'x';
                },
                ...LEAVE_THE_REALM,
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')).toMatchObject({ email: 'new@example.com', emailConfirmed: true });
        expect(sent.map((e) => [e.to, e.subject.replace(/\d{6}/, 'N')])).toEqual([
            ['new@example.com', 'Final Quest 2: your code is N'],
            ['hero@example.com', 'Final Quest 2: your email address was changed'],
        ]);
        expect(sent[0]?.text).toContain("new email address of Hero's account");
        expect(logs).toContain('Hero changed their email address.');
    });

    test('a wrong password changes nothing; three and the player is shown out', async () => {
        const store = new Store(':memory:');
        account(store);
        const wrong = [...typed('nope123'), 'x', 'escape', ...pick(1)];
        const { run, term } = session([...CHANGE, ...wrong, ...wrong, ...typed('nope123'), 'x'], { store });
        await run.run();
        expect(term.remaining).toBe(0);
        expect(row(term.screen, 25).trim()).toBe('Too many wrong passwords. Goodbye.');
        expect(store.account('hero')?.email).toBe('hero@example.com');
    });

    test('Escape at the code keeps the old address', async () => {
        const store = new Store(':memory:');
        account(store);
        const { run, term } = session([...CHANGE, ...typed('secret1'), ...typed('new@example.com'), 'escape', NOT_NOW, ...LEAVE_THE_REALM, LEAVE], { store });
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')).toMatchObject({ email: 'hero@example.com', emailConfirmed: true });
    });

    test('an address another account confirms meanwhile is turned down', async () => {
        const store = new Store(':memory:');
        account(store);
        const other = store.createAccount('Other', 'h', 'new@example.com')?.id ?? 0;
        const { run, term } = session(
            (t) => [
                ...CHANGE,
                ...typed('secret1'),
                ...typed('new@example.com'),
                () => {
                    store.confirmEmail(other);
                    return lastCode().charAt(0);
                },
                ...CODE.slice(1),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('That email address already has an account.');
                    return 'x';
                },
                ...LEAVE_THE_REALM,
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(store.account('hero')?.email).toBe('hero@example.com');
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

    test('a banned account is told why, and not let in (and it is no wrong password)', async () => {
        const store = new Store(':memory:');
        const id = account(store);
        store.setBanned(id, 'Rude to the innkeeper.');
        const { run, logs, term } = session(
            (t) => [
                ...LOG_IN,
                ...typed('hero'),
                ...typed('secret1'),
                () => {
                    expect(row(t.screen, 25).trim()).toBe('You are banned from the realm: Rude to the innkeeper.');
                    return 'x';
                },
                LEAVE,
            ],
            { store },
        );
        await run.run();
        expect(term.remaining).toBe(0);
        expect(logs).toEqual(['Hero tried to come in, but is banned.']);
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
                    // (This key still arrives; the next read finds the
                    // connection gone.)
                    t.disconnect();
                    return 'x';
                },
            ],
            { store },
        );
        await run.run();
        expect(store.loadPlayer(id)).toMatchObject({ x: 11 });
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

    test("an error before the game has a player is still the one logged (there's nothing to save)", async () => {
        const store = new Store(':memory:');
        const id = account(store);
        const { run, logs, released } = session([...LOG_IN, ...typed('hero'), ...typed('secret1')], { store, brokenStart: true });
        await run.run();
        expect(logs.some((line) => line.startsWith('Session error: Error: The game broke as it began.'))).toBe(true);
        expect(store.loadPlayer(id)).toBeNull();
        expect(released).toEqual([id]);
    });

    test('save does nothing when no one is playing', () => {
        const { run } = session([]);
        expect(() => {
            run.save();
        }).not.toThrow();
    });
});
