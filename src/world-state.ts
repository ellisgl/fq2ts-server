// The world's state on a server (a game's Content.world): one for everyone
// playing, kept in the database so it lasts through restarts. When it
// changes, everyone's screen is redrawn (on their next wait for a key), as
// what's drawn may depend on it.

import { restoreWorld, type WorldRecord, type WorldStore, type WorldValue } from '@fq2js/engine/shared';
import type { Store } from './store.ts';

export class ServerWorld implements WorldStore {
    private readonly values = new Map<string, WorldValue>();
    private readonly store: Store;
    private readonly changed: () => void;

    // `changed` is told after every change.
    public constructor(store: Store, defaults: WorldRecord, changed: () => void, log: (line: string) => void) {
        this.store = store;
        this.changed = changed;
        // Values the game no longer has, or that are of another kind now
        // (the game changed), are let go.
        for (const [name, value] of Object.entries(store.worldValues())) {
            try {
                for (const [key, v] of Object.entries(restoreWorld(defaults, { [name]: value }, 'world'))) {
                    this.values.set(key, v);
                }
            } catch (error) {
                log(`World: ${error instanceof Error ? error.message : String(error)}; it starts again.`);
            }
        }
    }

    public get(name: string): WorldValue | undefined {
        return this.values.get(name);
    }

    public set(name: string, value: WorldValue): void {
        this.values.set(name, value);
        this.store.setWorldValue(name, value);
        this.changed();
    }
}
