import { expect, test } from 'bun:test';
import { RemoteIO } from '../src/remote.ts';
import { Terminal } from '@fq2ts/engine/terminal';

test('a Terminal on a RemoteIO reads what is typed and sends what it draws', async () => {
    const sent: string[] = [];
    const io = new RemoteIO((text) => sent.push(text));
    const term = new Terminal({ input: io.input, output: io.output });
    term.start();
    io.typed('a\x1b[A');
    expect(await term.key()).toBe('a');
    expect(await term.key()).toBe('up');
    expect(sent.join('')).toContain('\x1b[?1049h');
});

test('the size starts at 80x25 and follows resizes', () => {
    const io = new RemoteIO(() => undefined);
    let resized = 0;
    io.output.on('resize', () => resized++);
    expect([io.columns, io.rows, io.output.columns, io.output.rows]).toEqual([80, 25, 80, 25]);
    io.resized(100, 40);
    expect([io.output.columns, io.output.rows]).toEqual([100, 40]);
    expect(resized).toBe(1);
});

test('a window too small is refused when the terminal starts', () => {
    const io = new RemoteIO(() => undefined);
    io.resized(70, 20);
    expect(() => {
        new Terminal({ input: io.input, output: io.output }).start();
    }).toThrow('at least 80x25 (this one is 70x20)');
});
