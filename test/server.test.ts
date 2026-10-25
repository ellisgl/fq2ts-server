// The whole server, on real sockets: telnet over TCP, and the web page and
// its web socket.

import { afterEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Client as SshClient } from 'ssh2';
import { startServer, type RunningServer, type ServerOptions } from '../../server/server.ts';
import { TELNET, TELNET_GREETING } from '../../server/telnet.ts';
import content from '../../content/index.ts';
import type { Flags } from '../../content/start.ts';
import { tempDir } from '../helpers.ts';

const { IAC, SB, SE, NAWS } = TELNET;
const DATA = join(import.meta.dir, '..', '..', 'data');
const DOWN = '\x1b[B';

let running: RunningServer | null = null;
let logs: string[] = [];

afterEach(async () => {
    await running?.stop();
    running = null;
});

function start(options: Partial<ServerOptions<Flags>> = {}): RunningServer {
    logs = [];
    running = startServer({
        content,
        dataDir: DATA,
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
    // Waits for this text to have been sent to the client.
    sees(text: string): Promise<void>;
    closed(): Promise<void>;
    received(): string;
    raw(): Uint8Array;
}

async function telnet(port: number, { size = [80, 25] as [number, number] | null } = {}): Promise<Client> {
    const chunks: Uint8Array[] = [];
    let isClosed = false;
    const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
            data: (_socket, data) => {
                chunks.push(new Uint8Array(data));
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
        sees: (text) => until(`"${text}"`, () => received().includes(text)),
        closed: () => until('the connection to close', () => isClosed),
        received,
        raw,
    };
}

async function browser(port: number): Promise<Client & { ws: WebSocket }> {
    let text = '';
    let isClosed = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onmessage = (event: MessageEvent<string>) => {
        text += event.data;
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
        sees: (wanted) => until(`"${wanted}"`, () => plain(text).includes(wanted)),
        closed: () => until('the web socket to close', () => isClosed),
        received: () => plain(text),
        raw: () => new TextEncoder().encode(text),
    };
}

async function ssh(port: number, { size = [80, 25] as [number, number], user = 'anyone' } = {}): Promise<Client & { resize(columns: number, rows: number): void }> {
    let text = '';
    let isClosed = false;
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
    stream.on('data', (data: Buffer) => {
        text += data.toString('utf8');
    });
    stream.on('close', () => {
        isClosed = true;
        client.end();
    });
    return {
        send: (data) => {
            stream.write(typeof data === 'string' ? data : Buffer.from(data));
        },
        sees: (wanted) => until(`"${wanted}"`, () => plain(text).includes(wanted)),
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
    await until('the code to be emailed', () => logs.some((line) => line.includes('your code is')));
    const code = /your code is (\d+)/.exec(logs.find((line) => line.includes('your code is')) ?? '')?.[1] ?? '';
    client.send(`${code}\r`);
    await client.sees('And');
    client.send('\r');
    await client.sees('wake');
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
        await first.sees('House');
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
        await again.sees('House');
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
        await client.sees('at least 80x25 (this one is 70x20)');
        await client.closed();
    });

    test('Ctrl-C hangs up, and a disconnect mid-game saves the player', async () => {
        const server = start();
        const client = await telnet(server.telnetPort ?? 0);
        await newPlayer(client);
        await client.sees('House');
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
        await first.sees('House');
        const second = await telnet(port);
        await second.sees('Log');
        second.send('\r');
        await second.sees('Name:');
        second.send('hero\rsecret1\r');
        await second.sees('already');
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
        await client.sees('House');
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
        await client.sees('House');
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
        await client.sees('House');
        await server.stop();
        running = null;
        await client.sees('The server is shutting down. Your game was saved.');
        await client.closed();
        expect(logs).toContain('Hero leaves the realm.');
    });
});
