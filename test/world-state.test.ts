import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ServerWorld } from '../src/world-state.ts';
import { Store } from '../src/store.ts';
import { tempDir } from '@fq2ts/engine/testing';
import { worldView } from '@fq2ts/engine/shared';

const DEFAULTS = { rings: 0, ringers: [] as readonly string[] };

test('keeps the world in the database, tells of every change, and lasts through a restart', () => {
    const path = join(tempDir(), 'world.sqlite');
    let changes = 0;
    const first = new Store(path);
    const world = worldView(DEFAULTS, new ServerWorld(first, DEFAULTS, () => changes++, () => undefined));
    world.rings = 3;
    world.ringers = ['Ann', 'Bob'];
    expect(changes).toBe(2);
    first.close();

    const again = worldView(DEFAULTS, new ServerWorld(new Store(path), DEFAULTS, () => undefined, () => undefined));
    expect({ ...again }).toEqual({ rings: 3, ringers: ['Ann', 'Bob'] });
});

test('values the game no longer has, or of another kind now, are let go (and logged)', () => {
    const store = new Store(':memory:');
    store.setWorldValue('rings', 'many');
    store.setWorldValue('gone', 1);
    store.setWorldValue('ringers', ['Ann']);
    const logs: string[] = [];
    const world = worldView(DEFAULTS, new ServerWorld(store, DEFAULTS, () => undefined, (line) => logs.push(line)));
    expect({ ...world }).toEqual({ rings: 0, ringers: ['Ann'] });
    expect(logs).toEqual(['World: world.rings: expected a number; it starts again.']);
});
