// The multiplayer server: players connect by SSH or with a web browser
// (an xterm.js page talking over a web socket), log in, and play. There's
// no telnet: it would send passwords in the clear.
//
// Everything runs in this one process: each connection gets a Terminal and
// a Session (the login screens, then a Game), sharing the world data and
// the database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { Terminal } from '@fq2js/engine/terminal';
import type { ColorDepth } from '@fq2js/engine/screen';
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
import { Gifts } from './gifts.ts';
import { bountyBoard } from './bounty.ts';
import { DEFAULT_RULES, type Rules } from './rules.ts';
import { Guard, normalAddress, webAddress } from './guard.ts';
import { rankings, whoIsOnline } from './lists.ts';
import { lostFight, mail, news, talk, yell } from './talk.ts';
import { escapeMarkup } from '@fq2js/engine/text';
import { listenSsh, type SshServer } from './ssh.ts';
import { Store } from './store.ts';
import type { WorldRecord } from '@fq2js/engine/shared';

export interface ServerOptions<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    content: Content<F, W>;
    // The game's data folder (config.json, items.json, monsters.json, maps/).
    dataDir: string;
    // The database file, or ':memory:'.
    database: string;
    host?: string;
    // Where the web page listens, if not `host` (127.0.0.1 behind a TLS
    // proxy, while SSH listens to everyone).
    webHost?: string;
    // Whether web players' addresses come from X-Forwarded-For (set by the
    // proxy in front). Without it, behind a proxy they all look like it.
    trustProxy?: boolean;
    // null turns the web off; 0 picks a free port.
    webPort?: number | null;
    // SSH is off unless given a port and the file for its host key (made
    // if it isn't there).
    ssh?: { port: number; hostKeyFile: string } | null;
    // The game's name, for players whose terminal won't do (default: "This game").
    gameName?: string;
    // A way of connecting failed after starting (its port was taken).
    onError?(error: Error): void;
    maxPlayers?: number;
    // The game rules (fights a day, what's won, chat, letters, news...);
    // those not given are the defaults (see rules.ts).
    rules?: Partial<Rules>;
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
    webPort: number | null;
    sshPort: number | null;
    connections(): number;
    // Saves everyone, says goodbye and closes every connection.
    stop(): Promise<void>;
}

// How long the web page has to say its window size.
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

    // Where the player is connecting from.
    public readonly address: string;

    // `colors` is how many the player's terminal shows.
    public constructor(send: (text: string) => void, hangUp: () => void, address: string, colors: ColorDepth, name?: string) {
        this.address = address;
        this.io = new RemoteIO((text) => {
            if (!this.closed) {
                send(text);
            }
        });
        this.term = new Terminal({ input: this.io.input, output: this.io.output, colors, ...(name === undefined ? {} : { name }) });
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
    const { content, dataDir, host = '127.0.0.1', webPort = 8080, maxPlayers = 50, idleMinutes = 30 } = options;
    const webHost = options.webHost ?? host;
    const log = options.log ?? ((line: string) => {
        console.log(`${new Date().toISOString()} ${line}`);
    });
    const mailer = options.mailer ?? logMailer(log);
    const rules: Rules = { ...DEFAULT_RULES, ...options.rules };
    const { config, ...data } = readGameData(dataDir);
    const mods = options.mods ?? [];
    for (const mod of mods) {
        log(`Mod: ${describeMod(mod)}`);
    }

    const shared: Shared<F, W> = {
        ...applyMods({ content, ...data }, mods),
        config,
        store: new Store(options.database, { log, mailbox: rules.mailbox, newsDays: rules.newsDays }),
    };
    const connections = new Set<Connection<F, W>>();
    const connect = (send: (text: string) => void, hangUp: () => void, address: string, colors: ColorDepth): Connection<F, W> => new Connection<F, W>(send, hangUp, normalAddress(address), colors, options.gameName);
    const guard = new Guard({ rules, now: options.now ?? Date.now });
    // Ends every connection from an address (it's been banned).
    const kickAddress = (address: string, message: string): void => {
        for (const connection of [...connections]) {
            if (connection.address === address) {
                connection.say(message);
                connection.close();
            }
        }
    };
    const realm = new Realm<F, W>({ chatWait: rules.chatWaitSeconds * 1000 });
    const gifts = new Gifts<F, W>({ realm, store: shared.store, items: shared.items });
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
    // Accounts no one finished making give their names back (now, and as
    // each day turns).
    let tidiedOn = '';
    const tidy = (): void => {
        if (tidiedOn === days.today) {
            return;
        }
        tidiedOn = days.today;
        const gone = shared.store.removeUnfinishedAccounts(new Date(now() - rules.unfinishedAccountDays * 86_400_000));
        if (gone.length) {
            log(`Removed ${gone.length} account${gone.length === 1 ? '' : 's'} never confirmed: ${gone.join(', ')}`);
        }
    };
    tidy();
    const worldStore = new ServerWorld(shared.store, shared.content.world, () => {
        realm.everyoneChanged();
    }, log);

    // A new connection, as it opens: true if it's turned away (its address
    // is banned, or has connected too often), and closed.
    const turnedAway = (connection: Connection<F, W>): boolean => {
        const banned = shared.store.addressBan(connection.address);
        if (banned !== null) {
            log(`Turned away ${connection.address}: it's banned.`);
            connection.say(`This address is banned from the realm: ${banned}`);
            connection.close();
            return true;
        }

        if (!guard.connect(connection.address)) {
            log(`Turned away ${connection.address}: too many connections.`);
            connection.say('Too many connections from your address. Please wait a minute.');
            connection.close();
            return true;
        }

        return false;
    };

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
                        W: { help: 'your mail: read and write letters', run: mail({ ...talking, lettersPerVisit: rules.lettersPerVisit }) },
                        D: { help: 'the daily news', run: news(talking) },
                        H: { help: 'fight a player next to you', run: attack({ realm, store: shared.store, days, world: shared.world, items: shared.items, me, now, fightsPerDay: rules.fightsPerDay, goldPercent: rules.pvpGoldPercent, expPercent: rules.pvpExpPercent }) },
                        G: { help: 'give gold or an item to a player next to you', run: gifts.give(me) },
                        K: { help: 'the bounty board (in town)', run: bountyBoard({ realm, store: shared.store, world: shared.world, me, now }) },
                        A: { help: 'accept (or refuse) what you were offered', run: gifts.accept(me) },
                        P: { help: "who's in the realm", run: whoIsOnline(realm, shared.world, id) },
                        ...(admin ? { '!': { help: 'the admin menu: kick, ban, tell everyone', run: adminMenu({ realm, store: shared.store, me, kick, kickAddress, log }) } } : {}),
                        L: { help: 'every player, ranked', run: rankings(realm, shared.store) },
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
                gifts.forget(id);
                playingOn.delete(id);
            },
            log,
            mailer,
            emailsPerVisit: rules.emailsPerVisit,
            address: connection.address,
            loginShut: (name) => {
                const shut = guard.loginShut(connection.address, name);
                if (shut !== null) {
                    log(`Turned away a login from ${connection.address} as ${name}: ${shut}`);
                }
                return shut;
            },
            loginFailed: (name) => {
                guard.failed(connection.address, name);
            },
            maySignUp: () => guard.maySignUp(connection.address),
            signedUp: () => {
                guard.signedUp(connection.address);
            },
            mayEmail: (to) => guard.email(connection.address, to),
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

    // ---- The web

    interface WebData {
        connection: Connection<F, W> | null;
        address: string;
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
                    const address = webAddress(server.requestIP(request)?.address ?? null, request.headers.get('x-forwarded-for'), options.trustProxy ?? false);
                    return server.upgrade(request, { data: { connection: null, address } }) ? undefined : new Response('Expected a web socket', { status: 400 });
                }

                if (url.pathname === '/') {
                    return new Response(PAGE, {
                        headers: {
                            'content-type': 'text/html; charset=utf-8',
                            // Not in anyone else's frame (where clicks and
                            // keys could be tricked out of a player).
                            'content-security-policy': "frame-ancestors 'none'",
                            'x-frame-options': 'DENY',
                            'x-content-type-options': 'nosniff',
                            'referrer-policy': 'no-referrer',
                        },
                    });
                }

                return new Response('Not found', { status: 404 });
            },
            websocket: {
                maxPayloadLength: MAX_MESSAGE,
                // A browser that stops reading is disconnected.
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
                        ws.data.address,
                        // (xterm.js shows any colour.)
                        'true',
                    );
                    ws.data.connection = connection;
                    connections.add(connection);
                    if (turnedAway(connection)) {
                        return;
                    }
                    // The page says its size straight away; if it doesn't,
                    // start anyway (at 80x25).
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
            connect: ({ columns, rows, colors }, send, hangUp, address) => {
                const connection = connect(send, hangUp, address, colors);
                connection.io.resized(columns, rows);
                connections.add(connection);
                if (!turnedAway(connection)) {
                    begin(connection);
                }
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
        tidy();
        guard.prune();
        const cutoff = Date.now() - idleMinutes * 60_000;
        for (const connection of connections) {
            if (connection.term.lastInput < cutoff) {
                connection.say(`You've been idle for ${idleMinutes} minutes. Goodbye!`);
                connection.close();
            }
        }
    }, options.idleCheck ?? IDLE_CHECK);

    return {
        webPort: web?.port ?? null,
        sshPort: ssh?.port ?? null,
        connections: () => connections.size,
        stop: async () => {
            clearInterval(idleTimer);
            // Take no new players. (Bun 1.3's server.stop() promise never
            // settles once a web socket has connected, though it does stop
            // listening; so it isn't awaited.)
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
            shared.store.close();
        },
    };
}

