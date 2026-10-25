// The whole server, on real sockets: telnet over TCP, and the web page and
// its web socket.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from '../../server/server.ts';
import { TELNET, TELNET_GREETING } from '../../server/telnet.ts';
import content from '../../content/index.ts';
import type { Flags } from '../../content/start.ts';

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

// Makes an account and plays into a new game, from the login menu.
async function newPlayer(client: Client, name = 'Hero'): Promise<void> {
    await client.sees('Log');
    client.send(`${DOWN}\r`);
    await client.sees('name:');
    client.send(`${name}\rsecret1\rsecret1\r`);
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
        first.send(`${DOWN}\r`);
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
