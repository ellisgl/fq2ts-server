// The whole server, on real sockets: telnet over TCP, and the web page and
// its web socket.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as SshClient } from 'ssh2';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';
import { TELNET, TELNET_GREETING } from '../src/telnet.ts';
import { ScreenModel } from './screen-model.ts';
import { hostKey, newHostKey } from '../src/ssh.ts';
import { Store } from '../src/store.ts';
import { runAdmin } from '../src/admin-cli.ts';
import { tempDir } from '@fq2js/engine/testing';
import { content, FIXTURE_DATA, type TestFlags } from '@fq2js/engine/fixture';
import { MOD_API, readMod, type ModContext } from '@fq2js/engine/mods';

const { IAC, SB, SE, NAWS } = TELNET;
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
        telnetPort: 0,
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

async function telnet(port: number, { size = [80, 25] as [number, number] | null } = {}): Promise<Client> {
    const chunks: Uint8Array[] = [];
    let isClosed = false;
    const model = new ScreenModel();
    const decoder = new TextDecoder();
    // The greeting is telnet commands, not text for the screen.
    let greeting = TELNET_GREETING.length;
    const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
            data: (_socket, data) => {
                const bytes = new Uint8Array(data);
                chunks.push(bytes);
                const skip = Math.min(greeting, bytes.length);
                greeting -= skip;
                model.feed(decoder.decode(bytes.subarray(skip), { stream: true }));
            },
            close: () => {
                isClosed = true;
            },
        },
    });
    const raw = (): Uint8Array => new Uint8Array(chunks.flatMap((c) => [...c]));
    const received = (): string => plain(new TextDecoder().decode(raw()));
    if (size) {
        const [w, h] = size;
        socket.write(new Uint8Array([IAC, SB, NAWS, 0, w, 0, h, IAC, SE]));
    }

    return {
        send: (data) => {
            socket.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        },
        sees: (text) => until(`"${text}"`, () => model.text().includes(text)),
        screen: () => model.text(),
        closed: () => until('the connection to close', () => isClosed),
        received,
        raw,
    };
}

async function browser(port: number): Promise<Client & { ws: WebSocket }> {
    let text = '';
    let isClosed = false;
    const model = new ScreenModel();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onmessage = (event: MessageEvent<string>) => {
        text += event.data;
        model.feed(event.data);
    };
    ws.onclose = () => {
        isClosed = true;
    };
    await until('the web socket to open', () => ws.readyState === WebSocket.OPEN);
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

async function ssh(port: number, { size = [80, 25] as [number, number], user = 'anyone' } = {}): Promise<Client & { resize(columns: number, rows: number): void }> {
    let text = '';
    let isClosed = false;
    const model = new ScreenModel();
    const client = new SshClient();
    const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
        client
            .on('ready', () => {
                client.shell({ cols: size[0], rows: size[1], term: 'xterm' }, (error, channel) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(channel);
                    }
                });
            })
            .on('error', reject)
            .connect({ host: '127.0.0.1', port, username: user });
    });
    const decoder = new TextDecoder();
    stream.on('data', (data: Buffer) => {
        const chunk = decoder.decode(data, { stream: true });
        text += chunk;
        model.feed(chunk);
    });
    stream.on('close', () => {
        isClosed = true;
        client.end();
    });
    return {
        send: (data) => {
            stream.write(typeof data === 'string' ? data : Buffer.from(data));
        },
        sees: (wanted) => until(`"${wanted}"`, () => model.text().includes(wanted)),
        screen: () => model.text(),
        closed: () => until('the SSH connection to close', () => isClosed),
        received: () => plain(text),
        raw: () => new TextEncoder().encode(text),
        resize: (columns, rows) => {
            stream.setWindow(rows, columns, 0, 0);
        },
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

describe('telnet', () => {
    test('greets, asks for the window size, and shows the login menu', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0);
        await client.sees('Log');
        expect([...client.raw().slice(0, TELNET_GREETING.length)]).toEqual([...TELNET_GREETING]);
        expect(client.received()).toContain('player');
    });

    test('a new player plays, leaves, and comes back to the same place', async () => {
        const server = start();
        const port = server.telnetPort ?? 0;
        const first = await telnet(port);
        await newPlayer(first);
        await first.sees('HP 100/100');
        first.send('\x1b[C');
        first.send('\x1b');
        await first.sees('Return');
        first.send(`${DOWN}${DOWN}\r`);
        await until('the player to be saved', () => logs.includes('Hero leaves the realm.'));
        first.send('\x1b');
        await first.closed();

        const again = await telnet(port);
        await again.sees('Log');
        again.send('\r');
        await again.sees('Name:');
        again.send('hero\rsecret1\r');
        await again.sees('HP 100/100');
        expect(logs.filter((line) => line === 'Hero enters the realm.')).toHaveLength(2);
    });

    test('without a window size, it starts anyway (at 80x25)', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0, { size: null });
        await client.sees('Log');
    });

    test('a window smaller than 80x25 is turned away', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0, { size: [70, 20] });
        await client.sees('This game needs a terminal of at least 80x25 (this one is 70x20)');
        await client.closed();
    });

    test('Ctrl-C hangs up, and a disconnect mid-game saves the player', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0);
        await newPlayer(client);
        await client.sees('HP 100/100');
        client.send('\x03');
        await client.closed();
        await until('the player to be saved', () => logs.includes('Hero leaves the realm.'));
        await until('the connection to be gone', () => server.connections() === 0);
    });

    test('the same account can only play once at a time', async () => {
        const server = start();
        const port = server.telnetPort ?? 0;
        const first = await telnet(port);
        await newPlayer(first);
        await first.sees('HP 100/100');
        const second = await telnet(port);
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
        const port = server.telnetPort ?? 0;
        const ann = await telnet(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        // Into the hut, and along to the bell.
        ann.send(DOWN + '\x1b[C'.repeat(15));
        await ann.sees('The bell has rung 1 times.');

        const bob = await telnet(port);
        await newPlayer(bob, 'Bob');
        await bob.sees('HP 100/100');
        bob.send(DOWN + '\x1b[C'.repeat(15));
        await bob.sees('The bell has rung 2 times.');
    });

    test('H attacks a player next to you; they hear of it', async () => {
        const server = start();
        const port = server.telnetPort ?? 0;
        const ann = await telnet(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await telnet(port);
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
        const port = server.telnetPort ?? 0;
        const ann = await telnet(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await telnet(port);
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
        const port = server.telnetPort ?? 0;
        const ann = await telnet(port);
        await newPlayer(ann, 'Ann');
        await ann.sees('HP 100/100');
        const bob = await telnet(port);
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
        expect(await page.text()).toContain('@xterm/xterm@5.5.0');
        expect((await fetch(`${base}/nope`)).status).toBe(404);
        expect((await fetch(`${base}/ws`)).status).toBe(400);
    });

    test('a browser plays over the web socket once it says its size', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        client.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 25 }));
        await newPlayer(client);
        await client.sees('HP 100/100');
    });

    test('a browser that never says its size starts anyway (at 80x25)', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        await client.sees('Log');
    });

    test('bad messages are logged and ignored', async () => {
        const server = start();
        const client = await browser(server.webPort ?? 0);
        client.ws.send('not json');
        client.ws.send(JSON.stringify({ type: 'shout' }));
        client.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 25 }));
        await client.sees('Log');
        expect(logs.filter((line) => line.startsWith('Bad web message'))).toHaveLength(2);
    });

    test('the web can be turned off', () => {
        const server = start({ webPort: null });
        expect(server.webPort).toBeNull();
        expect(server.telnetPort).not.toBeNull();
    });
});

describe('SSH', () => {
    const withSsh = (): RunningServer => start({ ssh: { port: 0, hostKeyFile: join(tempDir(), 'host_key') } });

    test('any user name gets in, to the login menu, and plays', async () => {
        const server = withSsh();
        const client = await ssh(server.sshPort ?? 0, { user: 'whoever' });
        await newPlayer(client);
        await client.sees('HP 100/100');
        client.send('\x03');
        await client.closed();
        await until('the player to be saved', () => logs.includes('Hero leaves the realm.'));
    });

    test('the window size comes from the terminal; a new size redraws the screen', async () => {
        const server = withSsh();
        const small = await ssh(server.sshPort ?? 0, { size: [70, 20] });
        await small.sees('at least 80x25 (this one is 70x20)');
        await small.closed();
        const client = await ssh(server.sshPort ?? 0, { size: [100, 30] });
        await client.sees('Log');
        const count = (): number => client.received().split('Forgot password').length - 1;
        expect(count()).toBe(1);
        client.resize(120, 40);
        await until('a redraw', () => count() === 2);
    });

    test('the host key is made once, readable only by its owner, and kept', async () => {
        const file = join(tempDir(), 'host_key');
        const first = start({ ssh: { port: 0, hostKeyFile: file } });
        const key = await Bun.file(file).text();
        expect(key).toContain('BEGIN OPENSSH PRIVATE KEY');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        await first.stop();
        start({ ssh: { port: 0, hostKeyFile: file } });
        expect(await Bun.file(file).text()).toBe(key);
    });

    test('a bad new key is made again, and a bad key file is reported', () => {
        const good = newHostKey();
        // One byte short, as ssh2 sometimes makes them.
        const [head = '', ...rest] = good.split('\n');
        const body = Buffer.from(rest.slice(0, -2).join(''), 'base64');
        const short = [head, body.subarray(0, -1).toString('base64'), ...rest.slice(-2)].join('\n');
        const made = [short, good];
        expect(newHostKey(() => made.shift() ?? '')).toBe(good);
        expect(() => newHostKey(() => short)).toThrow("Couldn't make an SSH host key.");

        const file = join(tempDir(), 'bad_key');
        writeFileSync(file, short);
        expect(() => hostKey(file)).toThrow(`The SSH host key in ${file} can't be read`);
    });

    test('SSH is off unless asked for', () => {
        expect(start().sshPort).toBeNull();
    });

    test('a port already taken is reported', async () => {
        const errors: Error[] = [];
        const first = withSsh();
        start({ ssh: { port: first.sshPort ?? 0, hostKeyFile: join(tempDir(), 'k') }, onError: (error) => errors.push(error), telnetPort: null, webPort: null });
        await until('the error', () => errors.length > 0);
        expect(errors[0]).toMatchObject({ code: 'EADDRINUSE' });
        await first.stop();
    });
});

test('mods are added to the game, and listed in the log', async () => {
    const mod = readMod({ id: 'sign', name: 'A Sign', version: '2.0', api: MOD_API, screens: { 1: { show: (g: ModContext) => {
        g.overlay('{x 2}{y 3}MODDED');
    } } } }, 'sign/mod.ts');
    const server = start({ mods: [{ mod, dir: 'sign', items: null, monsters: null, maps: [] }] });
    expect(logs).toContain('Mod: A Sign 2.0 (sign)');
    const client = await telnet(server.telnetPort ?? 0);
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
        const port = server.telnetPort ?? 0;
        const logIn = async (name: string): Promise<Client> => {
            const client = await telnet(port);
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
    test('when the realm is full, others are turned away', async () => {
        const server = start({ maxPlayers: 1 });
        const first = await telnet(server.telnetPort ?? 0);
        await first.sees('Log');
        const second = await telnet(server.telnetPort ?? 0);
        await second.sees('The realm is full');
        await second.closed();
    });

    test('idle players are disconnected', async () => {
        const server = start({ idleMinutes: 0, idleCheck: 50 });
        const client = await telnet(server.telnetPort ?? 0);
        await client.sees('idle for 0 minutes');
        await client.closed();
    });

    test('stopping saves everyone and says goodbye', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0);
        await newPlayer(client);
        await client.sees('HP 100/100');
        await server.stop();
        running = null;
        await client.sees('The server is shutting down. Your game was saved.');
        await client.closed();
        expect(logs).toContain('Hero leaves the realm.');
    });
});
