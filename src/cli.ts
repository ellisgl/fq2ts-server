// The multiplayer server's command line, for any game: a game's own server
// script calls runServer with its content and data folder.
//
//   bun run server [options]  (-h for them)
//
// Settings come from the command line, else the environment (or a .env
// file), else their defaults; see USAGE.

import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Content } from '@fq2js/engine/game';
import type { FlagRecord } from '@fq2js/engine/player';
import { loadMods, type LoadedMod } from '@fq2js/engine/mods';
import { startServer, type RunningServer } from './server.ts';
import { smtpMailer, type Mailer } from './mail.ts';
import type { WorldRecord } from '@fq2js/engine/shared';

export interface ServerCli<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    content: Content<F, W>;
    // The game's data folder (config.json, items.json, monsters.json, maps/).
    gameData: string;
    // The game's name, for players whose terminal won't do.
    name?: string;
    // The database's file name, in the --data folder (default: game.sqlite).
    database?: string;
    // The command line (default: this process's).
    args?: readonly string[];
    // What environment variables start with (default: FQ2_): --telnet-port
    // is FQ2_TELNET_PORT.
    envPrefix?: string;
}

// The help, with the environment variables' names.
const usage = (prefix: string): string => `Usage: server [options]

Each option can also be set in the environment, or in a .env file in the
folder the server is started from (see .env.example): --telnet-port is
${prefix}TELNET_PORT, and so on. Options given here win.

  --host ADDRESS        where to listen (default: 127.0.0.1, this computer
                        only; 0.0.0.0 lets other computers in)
  --web-host ADDRESS    where the web page listens, if not --host (say
                        127.0.0.1 behind a TLS proxy)
  --telnet-port N       telnet port (default: 2323)
  --web-port N          web port (default: 8080); players open http://host:N/
  --ssh-port N          SSH port (default: 2222); players use
                        ssh -p N host (any user name, no password)
  --no-telnet           don't accept telnet (it sends passwords unencrypted)
  --no-web              don't accept web browsers
  --no-ssh              don't accept SSH
  --data DIR            where the database and the SSH host key go
                        (default: server-data)
  --mods DIR            the mods to add to the game, a folder each
                        (default: mods, if there is one)
  --max-players N       connections at once (default: 50)
  --idle-minutes N      disconnect players idle this long (default: 30)
  --smtp-host HOST      the mail server that sends players' codes (without
                        one, emails are written to the log instead)
  --smtp-port N         its port (default: 587; 465 for TLS from the start)
  --smtp-user NAME      who to log in to it as; the password is only read
                        from the environment, as ${prefix}SMTP_PASSWORD
  --mail-from ADDRESS   who the emails are from (default: the --smtp-user)
  -h, --help            show this help`;

// Runs the server until it's stopped (Ctrl-C), or exits if it can't start.
export async function runServer<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ content, gameData, name, database = 'game.sqlite', args = process.argv.slice(2), envPrefix = 'FQ2_' }: ServerCli<F, W>): Promise<void> {
    const { values } = parseArgs({
        args: [...args],
        options: {
            'host': { type: 'string' },
            'web-host': { type: 'string' },
            'telnet-port': { type: 'string' },
            'web-port': { type: 'string' },
            'no-telnet': { type: 'boolean' },
            'no-web': { type: 'boolean' },
            'ssh-port': { type: 'string' },
            'no-ssh': { type: 'boolean' },
            'data': { type: 'string' },
            'mods': { type: 'string' },
            'max-players': { type: 'string' },
            'idle-minutes': { type: 'string' },
            'smtp-host': { type: 'string' },
            'smtp-port': { type: 'string' },
            'smtp-user': { type: 'string' },
            'mail-from': { type: 'string' },
            'help': { type: 'boolean', short: 'h', default: false },
        },
    });

    if (values.help) {
        console.log(usage(envPrefix));
        process.exit(0);
    }

    type Name = Exclude<keyof typeof values, 'help'>;

    // An option's environment variable: --telnet-port is FQ2_TELNET_PORT.
    const envName = (name: Name): string => `${envPrefix}${name.toUpperCase().replaceAll('-', '_')}`;
    // How to name an option in a message.
    const both = (name: Name): string => `--${name} (or ${envName(name)})`;

    const fail = (message: string): never => {
        console.error(message);
        process.exit(1);
    };

    // An option from the command line, else the environment, else its default.
    function setting(name: Name): string | undefined;
    function setting(name: Name, fallback: string): string;
    function setting(name: Name, fallback?: string): string | undefined {
        const given = values[name];
        if (typeof given === 'string') {
            return given;
        }

        const env = process.env[envName(name)];
        return env === undefined || env === '' ? fallback : env;
    }

    function number(name: Name, fallback: number): number {
        const value = setting(name, String(fallback));
        return /^\d+$/.test(value) ? Number(value) : fail(`${both(name)} must be a whole number, not "${value}".`);
    }

    function flag(name: Name): boolean {
        if (values[name] === true) {
            return true;
        }

        const env = (process.env[envName(name)] ?? '').toLowerCase();
        if (['', '0', 'false', 'no'].includes(env)) {
            return false;
        }

        return ['1', 'true', 'yes'].includes(env) || fail(`${envName(name)} must be true or false, not "${env}".`);
    }

    // Where players' codes are emailed from, if anywhere.
    function mailer(): Mailer | null {
        const host = setting('smtp-host');
        if (host === undefined) {
            console.warn(`No ${both('smtp-host')}: emails (with players' codes) will be written to the log, not sent.`);
            return null;
        }

        const user = setting('smtp-user');
        const from = setting('mail-from') ?? user ?? fail(`${both('mail-from')} is needed (or --smtp-user) to say who the emails are from.`);
        const password = process.env[`${envPrefix}SMTP_PASSWORD`];
        return smtpMailer({
            host,
            port: number('smtp-port', 587),
            from,
            ...(user === undefined ? {} : { user }),
            ...(password === undefined ? {} : { password }),
        });
    }

    const dataDir = resolve(setting('data', 'server-data'));
    const mail = mailer();
    let mods: LoadedMod[] = [];
    try {
        mods = await loadMods(resolve(setting('mods', 'mods')));
    } catch (error) {
        fail(`A mod couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }

    mkdirSync(dataDir, { recursive: true });

    // Starts the server, or explains why it can't (a port someone else has,
    // for one) and exits.
    function start(): RunningServer {
        try {
            return startServer({
                content,
                ...(name === undefined ? {} : { gameName: name }),
                dataDir: gameData,
                database: join(dataDir, database),
                host: setting('host', '127.0.0.1'),
                webHost: setting('web-host', setting('host', '127.0.0.1')),
                telnetPort: flag('no-telnet') ? null : number('telnet-port', 2323),
                webPort: flag('no-web') ? null : number('web-port', 8080),
                ssh: flag('no-ssh') ? null : { port: number('ssh-port', 2222), hostKeyFile: join(dataDir, 'ssh_host_ed25519_key') },
                onError: (error) => {
                    fail(couldNotStart(error));
                },
                maxPlayers: number('max-players', 50),
                mods,
                idleMinutes: number('idle-minutes', 30),
                ...(mail ? { mailer: mail } : {}),
            });
        } catch (error) {
            return fail(couldNotStart(error));
        }
    }

    // Why the server couldn't start.
    function couldNotStart(error: unknown): string {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        return code === 'EADDRINUSE'
            ? 'A port the server needs is already in use. Is it running already? (--telnet-port, --web-port and --ssh-port choose others.)'
            : `The server couldn't start: ${error instanceof Error ? error.message : String(error)}`;
    }

    const server = start();

    const shutDown = (): void => {
        console.log('Shutting down...');
        void server.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutDown);
    process.on('SIGTERM', shutDown);
}
