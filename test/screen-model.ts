// What a player's terminal would show: the screen the server's output
// draws, kept up as it arrives. The server sends only what changed, so
// the stream itself isn't the screen ("Bob leaves the realm." after "Bob
// enters the realm." arrives as "leave"); this is.
//
// It knows what the engine sends: cursor moves (CSI row;col H), clearing
// (CSI 2J), carriage returns and line feeds. Colours and modes are skipped.

import { HEIGHT, WIDTH } from '@fq2js/engine/screen';

export class ScreenModel {
    private readonly rows: string[][] = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => ' '));
    private row = 0;
    private col = 0;
    // The start of an escape sequence split across chunks.
    private pending = '';

    public feed(chunk: string): void {
        const text = this.pending + chunk;
        this.pending = '';
        let i = 0;
        while (i < text.length) {
            const ch = text[i] ?? '';
            if (ch === '\x1b') {
                const match = /^\x1b\[([0-9;?<]*)[ -/]*([@-~])/.exec(text.slice(i, i + 40));
                if (!match) {
                    // Not all here yet (or not a sequence the engine sends).
                    if (text.length - i < 40) {
                        this.pending = text.slice(i);
                        return;
                    }
                    i++;
                    continue;
                }

                const [all, params = '', final] = match;
                if (final === 'H') {
                    const [y = 1, x = 1] = params.split(';').map(Number);
                    this.row = y - 1;
                    this.col = x - 1;
                } else if (final === 'J' && params === '2') {
                    for (const row of this.rows) {
                        row.fill(' ');
                    }
                }
                i += all.length;
            } else if (ch === '\r') {
                this.col = 0;
                i++;
            } else if (ch === '\n') {
                this.row = Math.min(this.row + 1, HEIGHT - 1);
                i++;
            } else {
                const point = String.fromCodePoint(text.codePointAt(i) ?? 32);
                const row = this.rows[this.row];
                if (row && this.col < WIDTH) {
                    row[this.col] = point;
                }
                this.col++;
                i += point.length;
            }
        }
    }

    // The screen as it is now, a line per row.
    public text(): string {
        return this.rows.map((row) => row.join('')).join('\n');
    }
}
