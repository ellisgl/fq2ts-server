// The bounty board (K, where a board would hang: towns and indoors, the
// safe places). A player can put gold on another's head, paid there and
// then; whoever beats that player in a fight collects all of it (see
// pvp.ts). Who posted it isn't said; the news says how much.

import type { FlagRecord } from '@fq2js/engine/player';
import type { Script } from '@fq2js/engine/script';
import type { WorldRecord } from '@fq2js/engine/shared';
import { escapeMarkup } from '@fq2js/engine/text';
import type { World } from '@fq2js/engine/world';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { Speaker } from './talk.ts';

export const MIN_BOUNTY = 10;

interface Board<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    store: Store;
    world: World;
    me: Speaker;
    now?(): number;
}

export function bountyBoard<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, store, world, me, now = Date.now }: Board<F, W>): Script<F, W> {
    return async (g) => {
        if (!world.isSafe(g.screenNumber)) {
            g.write('{yellow}The bounty board hangs in town.');
            return;
        }

        g.cls();
        g.print('{yellow}The bounty board', '', '{gray}Gold on the heads of players: beat one in a fight to collect it.', '');
        const choice = await g.choice(['Read the bounties', 'Put a price on someone\'s head', 'Never mind']);
        if (choice === 0) {
            const bounties = store.bounties();
            await g.scroll(
                bounties.length ? bounties.map(({ name, amount }) => `{white}${escapeMarkup(name).padEnd(22)}{yellow}$${amount}`) : ['{gray}No one has a price on their head.'],
                'The bounty board',
            );
            return;
        }
        if (choice !== 1) {
            return;
        }

        g.cls();
        g.print('{white}Whose head?');
        const name = (await g.ask({ x: 1, y: 2, length: 21 }))?.trim();
        if (!name) {
            return;
        }

        const target = store.account(name);
        const reason = !target || store.loadPlayer(target.id) === null ? "There's no player by that name." : target.id === me.id ? "You can't put a price on your own head." : null;
        if (!target || reason !== null) {
            g.print('', `{yellow}${reason ?? ''}`);
            await g.key();
            return;
        }

        g.print('', `{white}How much? {gray}(At least $${MIN_BOUNTY}; you have $${g.gold}.)`);
        const amount = await g.number({ x: 1, y: 5, length: 10 });
        if (amount < MIN_BOUNTY || amount > g.gold) {
            g.print('', amount > g.gold ? "{yellow}You haven't that much." : `{yellow}At least $${MIN_BOUNTY}, or it isn't worth the paper.`);
            await g.key();
            return;
        }

        g.gold -= amount;
        store.postBounty(target.id, me.id, amount, now());
        const who = escapeMarkup(target.name);
        store.addNews(`{yellow}Someone has put $${amount} on ${who}'s head.`, now());
        realm.toMember(target.id, `{lightred}Someone has put $${amount} on your head!`);
        g.print('', `{lightgreen}The board now says $${amount} more for whoever beats ${who}.`);
        await g.key();
    };
}
