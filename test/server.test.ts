// The whole server, on real sockets: the web page and its web socket.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';
import { ScreenModel } from './screen-model.ts';
import { Store } from '../src/store.ts';
import { runAdmin } from '../src/admin-cli.ts';
import { tempDir } from '@fq2ts/engine/testing';
import { content, FIXTURE_DATA, type TestFlags } from '@fq2ts/engine/fixture';
import { MOD_API, readMod, type ModContext } from '@fq2ts/engine/mods';

const DOWN = '\x1b[B';

let running: RunningServer | null = null;
let logs: string[] = [];

afterEach(async () => {
    await running?.stop();
    running = null;
});

function start(options: Partial<ServerOptions<TestFlags>> = {}): RunningServer {
    logs = [];
    running = startServer({
        content,
        dataDir: FIXTURE_DATA,
        database: ':memory:',
        webPort: 0,
        log: (line) => logs.push(line),
        hashPassword: (p) => Promise.resolve(`hash:${p}`),
        verifyPassword: (p, h) => Promise.resolve(h === `hash:${p}`),
        ...options,
    });
    return running;
}

// What a client has seen, as plain text (escape sequences taken out).
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?<]*[A-Za-z ]/g, '');


// Waits until `ready` says yes, or fails after a while.
async function until(what: string, ready: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!ready()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}.`);
        }

        await Bun.sleep(10);
    }
}

interface Client {
    send(data: string | Uint8Array): void;
    // Waits for this text to be on the client's screen.
    sees(text: string): Promise<void>;
    // The client's screen now.
    screen(): string;
    closed(): Promise<void>;
    received(): string;
    raw(): Uint8Array;
}

// A browser, which says its window size (as the page does) unless told not to.
async function browser(port: number, { size = [80, 25] as [number, number] | null, headers = {} } = {}): Promise<Client & { ws: WebSocket }> {
    let text = '';
    let isClosed = false;
    const model = new ScreenModel();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.onmessage = (event: MessageEvent<string>) => {
        text += event.data;
        model.feed(event.data);
    };
    ws.onclose = () => {
        isClosed = true;
    };
    // (Open, or turned away: then the server says why, and closes it.)
    await until('the web socket to open', () => ws.readyState !== WebSocket.CONNECTING);
    if (size && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: size[0], rows: size[1] }));
    }
    return {
        ws,
        send: (data) => {
            ws.send(typeof data === 'string' ? JSON.stringify({ type: 'input', data }) : data);
        },
        sees: (wanted) => until(`"${wanted}"`, () => model.text().includes(wanted)),
        screen: () => model.text(),
        closed: () => until('the web socket to close', () => isClosed),
        received: () => plain(text),
        raw: () => new TextEncoder().encode(text),
    };
}

// Makes an account and plays into a new game, from the login menu.
async function newPlayer(client: Client, name = 'Hero'): Promise<void> {
    await client.sees('Log');
    client.send(`${DOWN}\r`);
    await client.sees('name:');
    client.send(`${name}\rsecret1\rsecret1\r`);
    await client.sees('Email:');
    client.send(`${name.toLowerCase()}@example.com\r`);
    // With no mail server, the email goes to the log.
    const email = `Email to ${name.toLowerCase()}@example.com:`;
    await until('the code to be emailed', () => logs.some((line) => line.startsWith(email)));
    const code = /your code is (\d+)/.exec(logs.findLast((line) => line.startsWith(email)) ?? '')?.[1] ?? '';
    client.send(`${code}\r`);
    await client.sees('A NEW GAME BEGINS');
    client.send(' ');
}

describe('playing', () => {
    test('shows the login menu', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await client.sees('Log');
        expect(client.received()).toContain('player');
    });

    test('a new player plays, leaves, and comes back to the same place', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const first = await browser(port);
        await newPlayer(first);
        await first.sees('HP 100/100');
        first.send('\x1b[C');
        first.send('\x1b');
        await first.sees('Return');
        first.send(`${DOWN}${DOWN}\r`);
        // (Warned they'll sleep where they are, they leave anyway.)
        await first.sees("You'll sleep here, where anyone can attack you. A room at an inn (Z) is safe.");
        first.send(`${DOWN}\r`);
        await until('the player to be saved', () => logs.includes('Hero leaves the realm.'));
        first.send('\x1b');
        await first.closed();

        const again = await browser(port);
        await again.sees('Log');
        again.send('\r');
        await again.sees('Name:');
        again.send('hero\rsecret1\r');
        await again.sees('HP 100/100');
        expect(logs.filter((line) => line === 'Hero enters the realm.')).toHaveLength(2);
    });

    test('a player who leaves sleeps where they were: the next one sees them, and S names them', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        ann.send('\x1b');
        await ann.sees('Return');
        ann.send(`${DOWN}${DOWN}\r`);
        await ann.sees('Leave anyway');
        ann.send(`${DOWN}\r`);
        await until('Ann to be saved', () => logs.includes('Ann leaves the realm.'));

        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        bob.send('s');
        await bob.sees('Here: Ann (sleeping)');
    });

    test('a player who takes a room at an inn is nowhere to be found, until they are back', async () => {
        // (Test Quest, with its first screen an inn.)
        const data = tempDir();
        cpSync(FIXTURE_DATA, data, { recursive: true });
        const first = join(data, 'maps', '0001.json');
        writeFileSync(first, JSON.stringify({ ...JSON.parse(readFileSync(first, 'utf8')), inn: true }));
        const server = start({ dataDir: data });
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        ann.send('z');
        await ann.sees('A room for the night');
        ann.send('\r');
        await ann.closed();
        expect(ann.received()).toContain('You sleep soundly. Come back soon!');
        await until('Ann to be saved', () => logs.includes('Ann leaves the realm.'));
        expect(logs).toContain('Ann takes a room at an inn.');

        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        bob.send('s');
        await bob.sees('No one else is on this screen.');

        // Back, she's out of her room: when she leaves again, she sleeps in the open.
        const again = await browser(port);
        await again.sees('Log');
        again.send('\r');
        await again.sees('Name:');
        again.send('ann\rsecret1\r');
        await again.sees('HP');
        again.send('\x1b');
        await again.sees('Return');
        again.send(`${DOWN}${DOWN}\r`);
        await again.sees("You'll sleep here in the open. Take a room (Z) to be safe from attack.");
        again.send(`${DOWN}\r`);
        await until('Ann to leave again', () => logs.filter((line) => line === 'Ann leaves the realm.').length === 2);
        bob.send('s');
        await bob.sees('Ann (sleeping)');
    });

    test('a window smaller than 80x25 is turned away', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0, { size: [70, 20] });
        await client.sees('This game needs a terminal of at least 80x25 (this one is 70x20)');
        await client.closed();
    });

    test('Ctrl-C hangs up, and a disconnect mid-game saves the player', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await newPlayer(client);
        await client.sees('HP 100/100');
        client.send('\x03');
        await client.closed();
        await until('the player to be saved', () => logs.includes('Hero leaves the realm.'));
        await until('the connection to be gone', () => server.connections() === 0);
    });

    test('the same account can only play once at a time', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const first = await browser(port);
        await newPlayer(first);
        await first.sees('HP 100/100');
        const second = await browser(port);
        await second.sees('Log');
        second.send('\r');
        await second.sees('Name:');
        second.send('hero\rsecret1\r');
        await second.sees('already');
    });
});

describe('the realm', () => {
    test("the world's state is shared: Bob hears the bell Ann rang", async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        // Into the hut, and along to the bell.
        ann.send(DOWN + '\x1b[C'.repeat(15));
        await ann.sees('The bell has rung 1 times.');

        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        bob.send(DOWN + '\x1b[C'.repeat(15));
        await bob.sees('The bell has rung 2 times.');
    });

    test("the server's rules are used: with no fights a day, there's no fighting", async () => {
        const server = start({ rules: { fightsPerDay: 0 } });
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        ann.send('h');
        await ann.sees("You've fought enough for one day.");
    });

    test('H attacks a player next to you; they hear of it', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        // Both stand where new games start: next to each other.
        ann.send('h');
        await ann.sees('Fight whom?');
        // (High rolls: Ann moves first, and gets away when she runs.)
        const random = spyOn(Math, 'random').mockReturnValue(0.99);
        try {
            ann.send('\r');
            await bob.sees('Ann attacks you!');
            // Ann thinks better of it, and runs.
            await ann.sees('Run for it');
            ann.send('\x1b[C\r');
            await bob.sees('Ann attacked you, then ran away.');
        } finally {
            random.mockRestore();
        }
    });

    test('players talk to each other, and the news has them', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        // (Ann's game hears Bob arrive first; then they're both on screen 1.)
        await ann.sees('Bob enters the realm.');
        bob.send('t');
        await bob.sees('Say:');
        bob.send('Hello, Ann!\r');
        await ann.sees('Bob says: "Hello, Ann!"');
        await bob.sees('You say: "Hello, Ann!"');

        ann.send('d');
        await ann.sees('The daily news');
        await ann.sees('Ann has come to the realm.');
        await ann.sees('Bob has come to the realm.');
    });

    test('players see each other arrive, walk about and leave; P lists them', async () => {
        const server = start();
        const port = server.webPort ?? 0;
        const ann = await browser(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await browser(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        await ann.sees('Bob enters the realm.');

        // Both start on screen 1; Bob walks two steps east, and Ann sees him
        // (as ☻: she's ☺).
        bob.send('\x1b[C\x1b[C');
        await ann.sees('☻');

        ann.send('p');
        await ann.sees("Who's in the realm (2)");
        await ann.sees('Ann');
        await ann.sees('Bob');
        ann.send('\x1b');

        bob.send('\x03');
        await bob.closed();
        await ann.sees('Bob leaves the realm.');
    });
});

describe('the web', () => {
    test('serves the page, and nothing else', async () => {
        const server = start();
        const base = `http://127.0.0.1:${server.webPort ?? 0}`;
        const page = await fetch(`${base}/`);
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
        const html = await page.text();
        // Nothing comes from elsewhere: the terminal is served from here.
        expect(html).not.toMatch(/(src|href)="https?:/);
        expect(html).toContain("from '/wterm.js'");
        const policy = page.headers.get('content-security-policy') ?? '';
        expect(policy).toContain("default-src 'self'");
        expect(policy).toContain("frame-ancestors 'none'");
        // (The page's own script, by its hash.)
        const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
        expect(policy).toContain(`'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`);
        const js = await fetch(`${base}/wterm.js`);
        expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(await js.text()).toContain('WTerm');
        const css = await fetch(`${base}/wterm.css`);
        expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
        expect(await css.text()).toContain('.wterm');
        expect(page.headers.get('x-content-type-options')).toBe('nosniff');
        expect((await fetch(`${base}/nope`)).status).toBe(404);
        expect((await fetch(`${base}/ws`)).status).toBe(400);
    });

    test('a browser plays over the web socket once it says its size', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await newPlayer(client);
        await client.sees('HP 100/100');
    });

    test('a browser is sent true colour', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await client.sees('Log');
        expect(new TextDecoder().decode(client.raw())).toContain(';38;2;');
    });

    test('a browser that never says its size starts anyway (at 80x25)', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0, { size: null });
        await client.sees('Log');
    });

    test('bad messages are logged and ignored', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0, { size: null });
        client.ws.send('not json');
        client.ws.send(JSON.stringify({ type: 'shout' }));
        client.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 25 }));
        await client.sees('Log');
        expect(logs.filter((line) => line.startsWith('Bad web message'))).toHaveLength(2);
    });

    test('the web can be turned off', () => {
        const server = start({ webPort: null });
        expect(server.webPort).toBeNull();
    });
});

test('a port already taken is reported', async () => {
    const first = start();
    expect(() => start({ webPort: first.webPort })).toThrow(expect.objectContaining({ code: 'EADDRINUSE' }));
    await first.stop();
});

test('mods are added to the game, and listed in the log', async () => {
    const mod = readMod({ id: 'sign', name: 'A Sign', version: '2.0', api: MOD_API, screens: { 1: { show: (g: ModContext) => {
        g.overlay('{x 2}{y 3}MODDED');
    } } } }, 'sign/mod.ts');
    const server = start({ mods: [{ mod, dir: 'sign', items: null, monsters: null, maps: [] }] });
    expect(logs).toContain('Mod: A Sign 2.0 (sign)');
    const client = await browser(server.webPort ?? 0);
    await newPlayer(client);
    await client.sees('MODDED');
});

describe('admins', () => {
    test('an admin (made with bun run admin) kicks a player, and a ban keeps them out', async () => {
        const dir = tempDir();
        const database = join(dir, 'game.sqlite');
        const store = new Store(database);
        for (const name of ['Ann', 'Bob']) {
            const id = store.createAccount(name, 'hash:secret1', `${name.toLowerCase()}@example.com`)?.id ?? 0;
            store.confirmEmail(id);
        }
        store.close();
        expect(runAdmin({ args: ['admin', 'Ann', '--data', dir], log: () => undefined })).toBe(0);

        const server = start({ database });
        const port = server.webPort ?? 0;
        const logIn = async (name: string): Promise<Client> => {
            const client = await browser(port);
            await client.sees('Log');
            client.send('\r');
            await client.sees('Name:');
            client.send(`${name}\rsecret1\r`);
            return client;
        };
        const ann = await logIn('Ann');
        await ann.sees('A NEW GAME BEGINS');
        ann.send(' ');
        const bob = await logIn('Bob');
        await bob.sees('A NEW GAME BEGINS');
        bob.send(' ');
        await bob.sees('HP 100/100');

        ann.send('!');
        await ann.sees('The admin menu');
        ann.send('\r');
        await ann.sees('Kick whom?');
        ann.send('\r');
        await ann.sees('Why is Bob being kicked?');
        ann.send('Testing\r');
        await bob.sees('You were removed from the realm by Ann: Testing');
        await bob.closed();
        expect(logs).toContain('Ann kicked Bob: Testing');
        ann.send('x');

        // Banned (from the command line, while the server runs), Bob can't
        // come back.
        expect(runAdmin({ args: ['ban', 'Bob', 'Go', 'away.', '--data', dir], log: () => undefined })).toBe(0);
        const again = await logIn('Bob');
        await again.sees('You are banned from the realm: Go away.');
    });
});

describe('limits and shutting down', () => {
    test('a banned address is turned away at the door', async () => {
        const database = join(tempDir(), 'game.sqlite');
        const store = new Store(database);
        // (The test connects from this machine.)
        store.banAddress('127.0.0.1', 'Go away.');
        store.close();
        const server = start({ database });
        const client = await browser(server.webPort ?? 0);
        await client.sees('This address is banned from the realm: Go away.');
        await client.closed();
        expect(logs).toContain("Turned away 127.0.0.1: it's banned.");
    });

    test("behind a proxy we trust, a web player's address is the one it forwards", async () => {
        const database = join(tempDir(), 'game.sqlite');
        const store = new Store(database);
        store.banAddress('198.51.100.7', 'Spam.');
        store.close();
        const forwarded = { 'X-Forwarded-For': '198.51.100.7' };

        const trusting = start({ database, trustProxy: true });
        const banned = await browser(trusting.webPort ?? 0, { headers: forwarded });
        await banned.sees('This address is banned from the realm: Spam.');
        await trusting.stop();

        // Not trusted, the header is anyone's to send, and isn't believed.
        const careful = start({ database });
        const client = await browser(careful.webPort ?? 0, { headers: forwarded });
        await client.sees('Log');
    });

    test('an address can only connect so often', async () => {
        const server = start({ rules: { connectionsPerMinute: 2 } });
        const port = server.webPort ?? 0;
        for (let i = 0; i < 2; i++) {
            await (await browser(port)).sees('Log');
        }
        const third = await browser(port);
        await third.sees('Too many connections from your address. Please wait a minute.');
        await third.closed();
    });

    test('wrong passwords from new connections still count: logins from the address stop', async () => {
        const server = start({ rules: { loginFailuresPerAddress: 2 } });
        const port = server.webPort ?? 0;
        const guess = async (): Promise<Client> => {
            const client = await browser(port);
            await client.sees('Log');
            client.send('\r');
            await client.sees('Name:');
            client.send('nobody\rguess\r');
            return client;
        };
        await (await guess()).sees('Wrong name or password.');
        await (await guess()).sees('Wrong name or password.');
        await (await guess()).sees('Too many wrong passwords from your address. Try again in 15 minutes.');
    });

    test('when the realm is full, others are turned away', async () => {
        const server = start({ maxPlayers: 1 });
        const first = await browser(server.webPort ?? 0);
        await first.sees('Log');
        const second = await browser(server.webPort ?? 0);
        await second.sees('The realm is full');
        await second.closed();
    });

    test('idle players are disconnected', async () => {
        const server = start({ idleMinutes: 0, idleCheck: 50 });
        const client = await browser(server.webPort ?? 0);
        await client.sees('idle for 0 minutes');
        await client.closed();
    });

    test('stopping saves everyone and says goodbye', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await newPlayer(client);
        await client.sees('HP 100/100');
        await server.stop();
        running = null;
        await client.sees('The server is shutting down. Your game was saved.');
        await client.closed();
        expect(logs).toContain('Hero leaves the realm.');
    });
});
