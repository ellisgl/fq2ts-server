// The keys the server adds to the game: P lists who's playing and where, L
// every player there is, ranked by experience.

import type { FlagRecord } from '@fq2js/engine/player';
import type { Script } from '@fq2js/engine/script';
import { escapeMarkup } from '@fq2js/engine/text';
import type { World } from '@fq2js/engine/world';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { WorldRecord } from '@fq2js/engine/shared';

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

// How many players L shows (the rest are counted).
export const RANKINGS_SHOWN = 200;

// L: the players there are (online or not), by experience, from the
// rankings the store keeps beside the saves (no save is read).
export function rankings<F extends FlagRecord, W extends WorldRecord = WorldRecord>(realm: Realm<F, W>, store: Store): Script<F, W> {
    return async (g) => {
        const online = new Set(realm.online().map(({ name }) => name.toLowerCase()));
        const { players, total } = store.rankings(RANKINGS_SHOWN);
        const lines = [
            `{gray}${'#'.padStart(4)}  ${'Name'.padEnd(NAME_WIDTH)}${'Experience'.padStart(12)}${'Gold'.padStart(10)}`,
            ...players.map(({ name, exp, gold }, i) => {
                const here = online.has(name.toLowerCase()) ? '{lightgreen}*' : ' ';
                return `{gray}${String(i + 1).padStart(4)} ${here}{white}${escapeMarkup(name).padEnd(NAME_WIDTH)}{yellow}${String(exp).padStart(12)}{gray}${String(gold).padStart(10)}`;
            }),
            ...(total > players.length ? [`{gray}...and ${total - players.length} more`] : []),
            '',
            '{lightgreen}*{gray} in the realm now',
        ];
        await g.scroll(lines, `Players (${total})`);
    };
}
