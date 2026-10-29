// A terminal at the other end of a network connection, as the input and
// output a Terminal needs. The connection (a web socket) passes in what the player types and how big their window is, and sends on what
// the game writes.

import { EventEmitter } from 'node:events';
import type { TerminalInput, TerminalOutput } from '@fq2ts/engine/terminal';
import { DEFAULT_SIZE, type ScreenSize } from '@fq2ts/engine/screen';

export class RemoteIO {
    public readonly input: TerminalInput;
    public readonly output: TerminalOutput;
    private readonly events = new EventEmitter();
    private size: { columns: number; rows: number };

    // `send` carries the game's output to the player. Until the player says
    // how big their window is, it's taken to be the game's `screen`.
    public constructor(send: (text: string) => void, screen: ScreenSize = DEFAULT_SIZE) {
        this.size = { columns: screen.width, rows: screen.height };
        const { events } = this;
        const size = (): { columns: number; rows: number } => this.size;
        this.input = {
            isTTY: true,
            setRawMode: () => undefined,
            resume: () => undefined,
            pause: () => undefined,
            on: (event, listener) => events.on(event, listener),
        };
        this.output = {
            isTTY: true,
            get columns() {
                return size().columns;
            },
            get rows() {
                return size().rows;
            },
            write: (text) => {
                send(text);
            },
            on: (event, listener) => events.on(event, listener),
        };
    }

    public get columns(): number {
        return this.size.columns;
    }

    public get rows(): number {
        return this.size.rows;
    }

    // The player typed something.
    public typed(text: string): void {
        this.events.emit('data', text);
    }

    // The player's window changed size.
    public resized(columns: number, rows: number): void {
        this.size = { columns, rows };
        this.events.emit('resize');
    }
}
