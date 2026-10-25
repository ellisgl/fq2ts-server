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
    // `hangUp` ends the connection.
    connect(size: { columns: number; rows: number }, send: (text: string) => void, hangUp: () => void): SshPlayer;
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
        writeFileSync(file, utils.generateKeyPairSync('ed25519').private, { mode: 0o600, flag: 'wx' });
    }

    return readFileSync(file, 'utf8');
}

export function listenSsh({ host, port, hostKeyFile, log, maxPending, connect, failed }: SshOptions): SshServer {
    const server = new Server({ hostKeys: [hostKey(hostKeyFile)] }, (client) => {
        let shell = false;
        let size = { columns: 80, rows: 25 };
        const timer = setTimeout(() => {
            if (!shell) {
                client.end();
            }
        }, HANDSHAKE_WAIT);

        client.on('authentication', (context) => {
            context.accept();
        });
        client.on('session', (accept) => {
            const session = accept();
            session.on('pty', (ok, _reject, info) => {
                // 0 is "don't know" (no terminal at the other end): 80x25.
                if (info.cols > 0 && info.rows > 0) {
                    size = { columns: info.cols, rows: info.rows };
                }

                answer(ok);
            });
            session.on('shell', (ok, reject) => {
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
                );
                session.on('window-change', (done, _reject, info) => {
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
