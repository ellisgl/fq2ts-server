// The multiplayer server: players connect by telnet or with a web browser
// (an xterm.js page talking over a web socket), log in, and play.
//
// Everything runs in this one process: each connection gets a Terminal and
// a Session (the login screens, then a Game), sharing the world data and
// the database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket, TCPSocketListener, Server, ServerWebSocket } from 'bun';
import { Terminal } from '@fq2js/engine/terminal';
import type { World } from '@fq2js/engine/world';
import { Game, type Config, type Content } from '@fq2js/engine/game';
import type { Bestiary } from '@fq2js/engine/combat';
import type { ItemCatalogue } from '@fq2js/engine/items';
import { readGameData } from '@fq2js/engine/data';
import { applyMods, describeMod, type LoadedMod } from '@fq2js/engine/mods';
import type { FlagRecord } from '@fq2js/engine/player';
import { field, integer, oneOf, record, string } from '@fq2js/engine/validate';
import { RemoteIO } from './remote.ts';
import { logMailer, type Mailer } from './mail.ts';
import { Session } from './session.ts';
import { Realm } from './realm.ts';
import { ServerWorld } from './world-state.ts';
import { Days } from './days.ts';
import { attack } from './pvp.ts';
import { adminMenu } from './admin.ts';
import { rankings, whoIsOnline } from './lists.ts';
import { lostFight, mail, news, talk, yell } from './talk.ts';
import { escapeMarkup } from '@fq2js/engine/text';
import { listenSsh, type SshServer } from './ssh.ts';
import { Store } from './store.ts';
import { TELNET_GREETING, TelnetParser } from './telnet.ts';
import type { WorldRecord } from '@fq2js/engine/shared';

export interface ServerOptions<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    content: Content<F, W>;
    // The game's data folder (config.json, items.json, monsters.json, maps/).
    dataDir: string;
    // The database file, or ':memory:'.
    database: string;
    host?: string;
    // Where the web page listens, if not `host` (127.0.0.1 behind a TLS
    // proxy, while telnet and SSH listen to everyone).
    webHost?: string;
    // null turns that way of connecting off; 0 picks a free port.
    telnetPort?: number | null;
    webPort?: number | null;
    // SSH is off unless given a port and the file for its host key (made
    // if it isn't there).
    ssh?: { port: number; hostKeyFile: string } | null;
    // The game's name, for players whose terminal won't do (default: "This game").
    gameName?: string;
    // A way of connecting failed after starting (its port was taken).
    onError?(error: Error): void;
    maxPlayers?: number;
    idleMinutes?: number;
    // How often to look for idle players, in milliseconds (default: 30s).
    idleCheck?: number;
    // The time, in milliseconds (for tests: days turn at midnight by it).
    now?(): number;
    log?(line: string): void;
    // Mods to add to the game (see @fq2js/engine/mods: loadMods reads them).
    mods?: readonly LoadedMod[];
    // Sends the codes that confirm addresses and reset passwords (default:
    // writes them to the log).
    mailer?: Mailer;
    // For tests: quicker password hashing.
    hashPassword?(password: string): Promise<string>;
    verifyPassword?(password: string, hash: string): Promise<boolean>;
}

export interface RunningServer {
    telnetPort: number | null;
    webPort: number | null;
    sshPort: number | null;
    connections(): number;
    // Saves everyone, says goodbye and closes every connection.
    stop(): Promise<void>;
}

// How long telnet waits for the client to say its window size.
const WINDOW_SIZE_WAIT = 500;
// How often idle players are looked for.
const IDLE_CHECK = 30_000;
// The largest web socket message accepted.
const MAX_MESSAGE = 4096;
// The most output kept waiting for a player whose connection isn't taking
// it (dozens of full screens). Past this, they've stopped reading, and the
// connection is closed rather than letting it build up.
const MAX_PENDING = 1024 * 1024;

const PAGE = readFileSync(join(import.meta.dir, 'client.html'), 'utf8');

interface Shared<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    world: World;
    config: Config;
    monsters: Bestiary;
    items: ItemCatalogue;
    content: Content<F, W>;
    store: Store;
}

// One player's connection, whichever way they came in.
class Connection<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    public readonly io: RemoteIO;
    public readonly term: Terminal;
    public session: Session<F, W> | null = null;
    public finished: Promise<void> = Promise.resolve();
    private closed = false;
    private readonly hangUp: () => void;

    public constructor(send: (text: string) => void, hangUp: () => void, name?: string) {
        this.io = new RemoteIO((text) => {
            if (!this.closed) {
                send(text);
            }
        });
        this.term = new Terminal({ input: this.io.input, output: this.io.output, ...(name === undefined ? {} : { name }) });
        this.hangUp = hangUp;
    }

    public get isClosed(): boolean {
        return this.closed;
    }

    // Ends the connection from this end.
    public close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.term.disconnect();
        this.hangUp();
    }

    // The other end has gone.
    public lost(): void {
        this.closed = true;
        this.term.disconnect();
    }

    // A last line for the player before the connection closes.
    public say(text: string): void {
        this.io.output.write(`\x1b[0m\r\n${text}\r\n`);
    }
}

export function startServer<F extends FlagRecord, W extends WorldRecord = WorldRecord>(options: ServerOptions<F, W>): RunningServer {
    const { content, dataDir, host = '127.0.0.1', telnetPort = 2323, webPort = 8080, maxPlayers = 50, idleMinutes = 30 } = options;
    const webHost = options.webHost ?? host;
    const log = options.log ?? ((line: string) => {
        console.log(`${new Date().toISOString()} ${line}`);
    });
    const mailer = options.mailer ?? logMailer(log);
    const { config, ...data } = readGameData(dataDir);
    const mods = options.mods ?? [];
    for (const mod of mods) {
        log(`Mod: ${describeMod(mod)}`);
    }

    const shared: Shared<F, W> = {
        ...applyMods({ content, ...data }, mods),
        config,
        store: new Store(options.database, { log }),
    };
    const connections = new Set<Connection<F, W>>();
    const connect = (send: (text: string) => void, hangUp: () => void): Connection<F, W> => new Connection<F, W>(send, hangUp, options.gameName);
    const realm = new Realm<F, W>();
    // Whose connection is whose (to kick them).
    const playingOn = new Map<number, Connection<F, W>>();
    const kick = (accountId: number, message: string): void => {
        const connection = playingOn.get(accountId);
        if (connection) {
            connection.say(message);
            connection.close();
        }
    };
    const now = options.now ?? Date.now;
    const days = new Days<F, W>({ store: shared.store, content: shared.content, realm, now });
    const worldStore = new ServerWorld(shared.store, shared.content.world, () => {
        realm.everyoneChanged();
    }, log);

    // Starts the session for a new connection (once the terminal size is known).
    const begin = (connection: Connection<F, W>): void => {
        const { term } = connection;
        if (connection.isClosed || connection.session) {
            return;
        }

        if (connections.size > maxPlayers) {
            connection.say('The realm is full. Please try again later.');
            connection.close();
            return;
        }

        try {
            term.start();
        } catch (error) {
            connection.say(error instanceof Error ? error.message : String(error));
            connection.close();
            return;
        }

        term.onInterrupt = () => {
            connection.close();
        };

        const session = new Session<F, W>({
            term,
            store: shared.store,
            content: shared.content,
            items: shared.items,
            config: shared.config,
            makeGame: ({ id, name, admin }, autosave) => {
                const me = { id, name };
                playingOn.set(id, connection);
                const talking = { realm, store: shared.store, me };
                const isNew = shared.store.loadPlayer(id) === null;
                // (A player back on a new day starts it afresh.)
                days.arrive(id);
                const game = new Game({
                    term,
                    world: shared.world,
                    config: shared.config,
                    monsters: shared.monsters,
                    items: shared.items,
                    content: shared.content,
                    autosave,
                    screensaver: false,
                    // Players share the world, so no cheating.
                    cheats: false,
                    figures: (screen) => realm.figures(id, screen),
                    moved: (player) => {
                        realm.moved(id, player);
                    },
                    keys: {
                        T: { help: 'say something to the players here', run: talk(talking) },
                        Y: { help: 'yell to everyone in the realm', run: yell(talking) },
                        W: { help: 'your mail: read and write letters', run: mail(talking) },
                        D: { help: 'the daily news', run: news(talking) },
                        H: { help: 'fight a player next to you', run: attack({ realm, store: shared.store, days, world: shared.world, items: shared.items, me, now }) },
                        P: { help: "who's in the realm", run: whoIsOnline(realm, shared.world, id) },
                        ...(admin ? { '!': { help: 'the admin menu: kick, ban, tell everyone', run: adminMenu({ realm, store: shared.store, me, kick, log }) } } : {}),
                        L: { help: 'every player, ranked', run: rankings(realm, shared.store, shared.content.start, shared.items) },
                    },
                    worldStore,
                    news: (text) => {
                        shared.store.addNews(text, Date.now());
                    },
                    fought: (_player, monster, result) => {
                        if (result === 'lost') {
                            shared.store.addNews(lostFight(name, monster), Date.now());
                        }
                    },
                });
                realm.attach(id, game);
                if (isNew) {
                    shared.store.addNews(`{lightcyan}${escapeMarkup(name)} has come to the realm.`, Date.now());
                }

                const unread = shared.store.unreadLetters(id);
                if (unread) {
                    game.notify(`{lightgreen}You have ${unread} new letter${unread === 1 ? '' : 's'}. (W to read.)`);
                }

                return game;
            },
            claim: ({ id, name }) => realm.claim(id, name),
            release: (id) => {
                realm.release(id);
                playingOn.delete(id);
            },
            log,
            mailer,
            ...(options.hashPassword ? { hashPassword: options.hashPassword } : {}),
            ...(options.verifyPassword ? { verifyPassword: options.verifyPassword } : {}),
        });
        connection.session = session;
        connection.finished = session.run().then(() => {
            if (!connection.isClosed) {
                term.stop();
            }

            connection.close();
            connections.delete(connection);
        });
    };

    // ---- Telnet

    let telnet: TCPSocketListener<undefined> | null = null;
    if (telnetPort !== null) {
        const bySocket = new WeakMap<Socket, { connection: Connection<F, W>; parser: TelnetParser; started: boolean; pending: Uint8Array[]; pendingBytes: number }>();
        const encoder = new TextEncoder();
        const write = (socket: Socket, bytes: Uint8Array): void => {
            const state = bySocket.get(socket);
            if (!state) {
                return;
            }

            if (state.pending.length) {
                if (state.pendingBytes + bytes.length > MAX_PENDING) {
                    log('Telnet: a player stopped reading; closing their connection.');
                    state.pending = [];
                    state.pendingBytes = 0;
                    state.connection.close();
                    return;
                }

                state.pending.push(bytes);
                state.pendingBytes += bytes.length;
                return;
            }

            const written = socket.write(bytes);
            if (written < bytes.length) {
                const rest = bytes.subarray(Math.max(0, written));
                state.pending.push(rest);
                state.pendingBytes += rest.length;
            }
        };
        const start = (socket: Socket): void => {
            const state = bySocket.get(socket);
            if (state && !state.started && !state.connection.isClosed) {
                state.started = true;
                begin(state.connection);
            }
        };

        telnet = Bun.listen({
            hostname: host,
            port: telnetPort,
            socket: {
                open: (socket) => {
                    const connection = connect(
                        (text) => {
                            write(socket, encoder.encode(text));
                        },
                        () => {
                            socket.end();
                        },
                    );
                    bySocket.set(socket, { connection, parser: new TelnetParser(), started: false, pending: [], pendingBytes: 0 });
                    connections.add(connection);
                    socket.write(TELNET_GREETING);
                    setTimeout(() => {
                        start(socket);
                    }, WINDOW_SIZE_WAIT);
                },
                data: (socket, bytes) => {
                    const state = bySocket.get(socket);
                    if (!state) {
                        return;
                    }

                    const { text, size } = state.parser.feed(bytes);
                    if (size) {
                        state.connection.io.resized(size.columns, size.rows);
                        start(socket);
                    }

                    if (text) {
                        state.connection.io.typed(text);
                    }
                },
                drain: (socket) => {
                    const state = bySocket.get(socket);
                    while (state?.pending.length) {
                        const [first] = state.pending;
                        if (!first) {
                            break;
                        }

                        const written = Math.max(0, socket.write(first));
                        state.pendingBytes -= Math.min(written, first.length);
                        if (written < first.length) {
                            state.pending[0] = first.subarray(written);
                            return;
                        }

                        state.pending.shift();
                    }
                },
                close: (socket) => {
                    const state = bySocket.get(socket);
                    if (state) {
                        state.connection.lost();
                        connections.delete(state.connection);
                    }
                },
                error: (socket, error) => {
                    log(`Telnet error: ${error.message}`);
                    bySocket.get(socket)?.connection.lost();
                },
            },
        });
        log(`Telnet: ${host} port ${telnet.port}`);
    }

    // ---- The web

    interface WebData {
        connection: Connection<F, W> | null;
    }

    let web: Server<WebData> | null = null;
    if (webPort !== null) {
        const parse = oneOf(['input', 'resize'] as const);
        web = Bun.serve<WebData>({
            hostname: webHost,
            port: webPort,
            fetch: (request, server) => {
                const url = new URL(request.url);
                if (url.pathname === '/ws') {
                    return server.upgrade(request, { data: { connection: null } }) ? undefined : new Response('Expected a web socket', { status: 400 });
                }

                if (url.pathname === '/') {
                    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
                }

                return new Response('Not found', { status: 404 });
            },
            websocket: {
                maxPayloadLength: MAX_MESSAGE,
                // A browser that stops reading is disconnected, as on telnet.
                backpressureLimit: MAX_PENDING,
                closeOnBackpressureLimit: true,
                open: (ws: ServerWebSocket<WebData>) => {
                    const connection = connect(
                        (text) => {
                            ws.send(text);
                        },
                        () => {
                            ws.close();
                        },
                    );
                    ws.data.connection = connection;
                    connections.add(connection);
                    // The page says its size straight away; if it doesn't,
                    // start anyway (at 80x25), as telnet does.
                    setTimeout(() => {
                        begin(connection);
                    }, WINDOW_SIZE_WAIT);
                },
                message: (ws: ServerWebSocket<WebData>, message) => {
                    const { connection } = ws.data;
                    if (!connection || typeof message !== 'string') {
                        return;
                    }

                    try {
                        const r = record(JSON.parse(message), 'message');
                        if (field(r, 'type', 'message', parse) === 'input') {
                            connection.io.typed(field(r, 'data', 'message', string));
                        } else {
                            connection.io.resized(field(r, 'cols', 'message', integer), field(r, 'rows', 'message', integer));
                            begin(connection);
                        }
                    } catch (error) {
                        log(`Bad web message: ${error instanceof Error ? error.message : String(error)}`);
                    }
                },
                close: (ws: ServerWebSocket<WebData>) => {
                    const { connection } = ws.data;
                    if (connection) {
                        connection.lost();
                        connections.delete(connection);
                    }
                },
            },
        });
        log(`Web: http://${webHost}:${web.port}/`);
    }

    // ---- SSH

    let ssh: SshServer | null = null;
    if (options.ssh) {
        ssh = listenSsh({
            host,
            port: options.ssh.port,
            hostKeyFile: options.ssh.hostKeyFile,
            log,
            maxPending: MAX_PENDING,
            connect: ({ columns, rows }, send, hangUp) => {
                const connection = connect(send, hangUp);
                connection.io.resized(columns, rows);
                connections.add(connection);
                begin(connection);
                return {
                    typed: (text) => {
                        connection.io.typed(text);
                    },
                    resized: (c, r) => {
                        connection.io.resized(c, r);
                    },
                    lost: () => {
                        connection.lost();
                        connections.delete(connection);
                    },
                };
            },
            failed: (error) => {
                (options.onError ?? ((e: Error) => {
                    log(`SSH: ${e.message}`);
                }))(error);
            },
        });
        log(`SSH: ${host} port ${ssh.port}`);
    }

    // ---- Idle players

    // Idle players go, and at midnight a new day dawns.
    const idleTimer = setInterval(() => {
        days.check();
        const cutoff = Date.now() - idleMinutes * 60_000;
        for (const connection of connections) {
            if (connection.term.lastInput < cutoff) {
                connection.say(`You've been idle for ${idleMinutes} minutes. Goodbye!`);
                connection.close();
            }
        }
    }, options.idleCheck ?? IDLE_CHECK);

    return {
        telnetPort: telnet?.port ?? null,
        webPort: web?.port ?? null,
        sshPort: ssh?.port ?? null,
        connections: () => connections.size,
        stop: async () => {
            clearInterval(idleTimer);
            // Take no new players. (Bun 1.3's server.stop() promise never
            // settles once a web socket has connected, though it does stop
            // listening; so it isn't awaited.)
            telnet?.stop();
            void web?.stop();
            ssh?.stop();
            // (Closing a connection takes it out of `connections`, so wait
            // for the ones open now.)
            const open = [...connections];
            for (const connection of open) {
                connection.session?.save();
                connection.say('The server is shutting down. Your game was saved.');
                connection.close();
            }

            await Promise.all(open.map((c) => c.finished));
            telnet?.stop(true);
            shared.store.close();
        },
    };
}

