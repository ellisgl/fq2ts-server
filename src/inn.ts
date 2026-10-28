// Inns (Z): a player at an inn (a screen marked `"inn": true`) can pay for
// a room and leave the realm. Until they're back, they're nowhere on the
// map, and no one can attack them; anyone who leaves anywhere else stays
// where they were, sleeping in the open (see pvp.ts).

import type { FlagRecord } from '@fq2ts/engine/player';
import type { Script } from '@fq2ts/engine/script';
import type { WorldRecord } from '@fq2ts/engine/shared';
import type { World } from '@fq2ts/engine/world';

// What a room costs, unless the server's rules say otherwise.
export const INN_COST = 20;

interface Inn {
    world: World;
    cost?: number;
    // Takes the player to their room: marks them asleep and closes their
    // connection (their game is saved as it closes).
    sleep(): void;
}

export function inn<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ world, cost = INN_COST, sleep }: Inn): Script<F, W> {
    return async (g) => {
        if (!world.isInn(g.screenNumber)) {
            g.write("{yellow}There's no inn here. (Sleep at an inn, and no one can find you while you're away.)");
            return;
        }

        g.cls();
        g.print(
            '{yellow}A room for the night',
            '',
            `{white}A room costs {yellow}$${cost}{white}. You'll leave the realm, and sleep safely here`,
            "{white}until you're back: no one can find you, or attack you, while you're away.",
            '',
            `{gray}You have {yellow}$${g.gold}{gray}.`,
            '',
        );
        if ((await g.choice([`Take a room ($${cost}) and leave the realm`, 'Not now'])) !== 0) {
            return;
        }

        if (g.gold < cost) {
            g.print('', "{yellow}You can't afford a room.");
            await g.key();
            return;
        }

        g.gold -= cost;
        sleep();
    };
}
