// The keys the server adds to the game: P lists who's playing and where, S
// who's on this screen, L every player there is, ranked by experience.

import type { FlagRecord } from '@fq2ts/engine/player';
import type { Script } from '@fq2ts/engine/script';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { World } from '@fq2ts/engine/world';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { WorldRecord } from '@fq2ts/engine/shared';

const NAME_WIDTH = 22;

// P: who's in the realm, and where.
export function whoIsOnline<F extends FlagRecord, W extends WorldRecord = WorldRecord>(realm: Realm<F, W>, world: World, accountId: number): Script<F, W> {
    return async (g) => {
        const lines = realm.online().map(({ accountId: id, name, place }) => {
            const where = place ? world.name(place.screen) || `screen ${place.screen}` : 'arriving';
            return `{white}${escapeMarkup(name).padEnd(NAME_WIDTH)}{gray}${escapeMarkup(where)}${id === accountId ? ' {yellow}(you)' : ''}`;
        });
        await g.scroll(lines, `Who's in the realm (${lines.length})`);
    };
}

// The widest the names S shows can be in the status bar; more go in a list.
const STATUS_WIDTH = 78;

// S: the names of the others on this screen (the ☻s), those who are away
// marked, in the status bar, or in a list if there are too many for it.
export function whoIsHere<F extends FlagRecord, W extends WorldRecord = WorldRecord>(realm: Realm<F, W>, accountId: number): Script<F, W> {
    return async (g) => {
        const here = realm.onScreen(accountId);
        if (!here.length) {
            g.write('{gray}No one else is on this screen.');
            return;
        }

        const shown = here.map(({ name, away }) => `{lightcyan}${escapeMarkup(name)}${away ? ' {gray}(sleeping)' : ''}`);
        const line = `Here: ${here.map(({ name, away }) => `${name}${away ? ' (sleeping)' : ''}`).join(', ')}`;
        if (line.length <= STATUS_WIDTH) {
            g.write(`{white}Here: ${shown.join('{white}, ')}`);
            return;
        }

        await g.scroll(shown, `On this screen (${here.length})`);
    };
}

// How many players L shows (the rest are counted).
export const RANKINGS_SHOWN = 200;

// L: the players there are (online or not), by experience, from the
// rankings the store keeps beside the saves (no save is read). With `jobs`
// (the game has the engine's jobs), how many each has done, too.
export function rankings<F extends FlagRecord, W extends WorldRecord = WorldRecord>(realm: Realm<F, W>, store: Store, { jobs = false } = {}): Script<F, W> {
    return async (g) => {
        const online = new Set(realm.online().map(({ name }) => name.toLowerCase()));
        const { players, total } = store.rankings(RANKINGS_SHOWN);
        const lines = [
            `{gray}${'#'.padStart(4)}  ${'Name'.padEnd(NAME_WIDTH)}${'Experience'.padStart(12)}${'Gold'.padStart(10)}${jobs ? 'Jobs'.padStart(8) : ''}`,
            ...players.map(({ name, exp, gold, jobs: done }, i) => {
                const here = online.has(name.toLowerCase()) ? '{lightgreen}*' : ' ';
                return `{gray}${String(i + 1).padStart(4)} ${here}{white}${escapeMarkup(name).padEnd(NAME_WIDTH)}{yellow}${String(exp).padStart(12)}{gray}${String(gold).padStart(10)}${jobs ? `{lightcyan}${String(done).padStart(8)}` : ''}`;
            }),
            ...(total > players.length ? [`{gray}...and ${total - players.length} more`] : []),
            '',
            '{lightgreen}*{gray} in the realm now',
        ];
        await g.scroll(lines, `Players (${total})`);
    };
}
