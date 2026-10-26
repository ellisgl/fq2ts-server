// Playing over SSH: the connection is encrypted, and anyone gets in (any
// user name, no password); then it's the same login screen as telnet and
// the web. Only a shell is offered: no commands, port forwarding or file
// transfer (ssh2 turns down whatever isn't listened for).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Server, utils, type ServerChannel } from 'ssh2';

// What the server does with a player who has connected.
export interface SshPlayer {
    typed(text: string): void;
    resized(columns: number, rows: number): void;
    // The connection has gone.
    lost(): void;
}

export interface SshOptions {
    host: string;
    port: number;
    // The server's private key, made the first time.
    hostKeyFile: string;
    log(line: string): void;
    // The most output kept for a player who isn't reading it.
    maxPending: number;
    // A player has a terminal, of this size; `send` writes to it, and
    // `hangUp` ends the connection. `address` is where they're connecting
    // from.
    connect(size: { columns: number; rows: number }, send: (text: string) => void, hangUp: () => void, address: string): SshPlayer;
    // The server couldn't listen (its port is taken, for one).
    failed(error: Error): void;
}

export interface SshServer {
    port: number;
    stop(): void;
}

// How long a client gets to log in and ask for a terminal.
const HANDSHAKE_WAIT = 30_000;

// Answers a request. ssh2 only gives an answer function when the client
// wants one, whatever its types say.
const answer = (reply: (() => void) | undefined): void => {
    reply?.();
};

// The host key from its file, made (ed25519) if there isn't one yet.
// Only its owner can read it.
export function hostKey(file: string): string {
    if (!existsSync(file)) {
        writeFileSync(file, newHostKey(), { mode: 0o600, flag: 'wx' });
    }

    const key = readFileSync(file, 'utf8');
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error) {
        throw new Error(`The SSH host key in ${file} can't be read (${parsed.message}). Move it away, and a new one is made.`);
    }

    return key;
}

// A new ed25519 key. About one time in 250, ssh2 makes one a byte short,
// which it then can't read; so each is checked, and a bad one made again.
export function newHostKey(generate: () => string = () => utils.generateKeyPairSync('ed25519').private): string {
    for (let tries = 0; tries < 10; tries++) {
        const key = generate();
        if (!(utils.parseKey(key) instanceof Error)) {
            return key;
        }
    }

    throw new Error("Couldn't make an SSH host key.");
}

export function listenSsh({ host, port, hostKeyFile, log, maxPending, connect, failed }: SshOptions): SshServer {
    const server = new Server({ hostKeys: [hostKey(hostKeyFile)] }, (client, info) => {
        let shell = false;
        // One session (and so one game) per connection: more would each be
        // kept until the client goes.
        let session = false;
        let size = { columns: 80, rows: 25 };
        const timer = setTimeout(() => {
            if (!shell) {
                client.end();
            }
        }, HANDSHAKE_WAIT);

        client.on('authentication', (context) => {
            context.accept();
        });
        client.on('session', (accept, reject) => {
            if (session) {
                reject();
                return;
            }
            session = true;
            const channel = accept();
            channel.on('pty', (ok, _reject, info) => {
                // 0 is "don't know" (no terminal at the other end): 80x25.
                if (info.cols > 0 && info.rows > 0) {
                    size = { columns: info.cols, rows: info.rows };
                }

                answer(ok);
            });
            channel.on('shell', (ok, reject) => {
                // One game per connection.
                if (shell) {
                    answer(reject);
                    return;
                }

                shell = true;
                clearTimeout(timer);
                const stream: ServerChannel = ok();
                const decoder = new TextDecoder('utf-8');
                let player: SshPlayer | null = null;
                const hangUp = (): void => {
                    stream.exit(0);
                    stream.end();
                    client.end();
                };
                player = connect(
                    size,
                    (text) => {
                        if (stream.writableLength > maxPending) {
                            log('SSH: a player stopped reading; closing their connection.');
                            hangUp();
                            return;
                        }

                        stream.write(text);
                    },
                    hangUp,
                    info.ip,
                );
                channel.on('window-change', (done, _reject, info) => {
                    if (info.cols > 0 && info.rows > 0) {
                        player?.resized(info.cols, info.rows);
                    }

                    answer(done);
                });
                stream.on('data', (data: Buffer) => {
                    player?.typed(decoder.decode(data, { stream: true }));
                });
                stream.on('close', () => {
                    player?.lost();
                    player = null;
                });
            });
        });
        client.on('close', () => {
            clearTimeout(timer);
        });
        client.on('error', (error) => {
            log(`SSH error: ${error.message}`);
        });
    });

    server.on('error', failed);
    server.listen(port, host);
    const address = server.address();
    return {
        port: typeof address === 'object' && address !== null ? address.port : port,
        stop: () => {
            server.close();
        },
    };
}
