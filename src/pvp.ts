// Fights between players (H): next to someone on your screen, out on the
// map, you can attack them. You fight them as you would a monster made of
// their stats; they're told at once, and of how it ended. The loser gives
// the winner a share of their gold (half, by default) and is left on 1
// hitpoint, and the winner gets some experience. Not on safe screens (interiors, and screens marked
// safe), not against someone already beaten (1 hitpoint), and only so many
// fights a day.

import { gearOf, type ItemCatalogue } from '@fq2js/engine/items';
import type { Monster } from '@fq2js/engine/combat';
import type { FlagRecord, Player } from '@fq2js/engine/player';
import type { Script } from '@fq2js/engine/script';
import type { WorldRecord } from '@fq2js/engine/shared';
import { escapeMarkup } from '@fq2js/engine/text';
import type { World } from '@fq2js/engine/world';
import type { Days } from './days.ts';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { Speaker } from './talk.ts';

// Unless the server's rules say otherwise: fights a day, and the shares of
// the loser's gold and experience the winner gets, in percent.
export const FIGHTS_PER_DAY = 3;
export const PVP_GOLD_PERCENT = 50;
export const PVP_EXP_PERCENT = 10;

interface Pvp<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    store: Store;
    days: Days<F, W>;
    world: World;
    items: ItemCatalogue;
    me: Speaker;
    now?(): number;
    fightsPerDay?: number;
    goldPercent?: number;
    expPercent?: number;
}

// Another player, as a monster to fight: their hitpoints now, their
// strength and weapon to hit with, their defence and armour to take blows.
// Its gold and experience are the shares of theirs the winner gets.
export function asMonster<F extends FlagRecord>(name: string, player: Player<F>, items: ItemCatalogue, { goldPercent = PVP_GOLD_PERCENT, expPercent = PVP_EXP_PERCENT } = {}): Monster {
    const gear = gearOf(player, items);
    const weapon = player.weapon === null ? 'fists' : items.get(player.weapon).name;
    const pronoun = player.sex === 'female' ? 'she' : 'he';
    return {
        name,
        says: `${name} squares up to you.`,
        pronoun,
        hp: Math.max(1, player.hp),
        defense: player.defense + gear.armour,
        gold: share(player.gold, goldPercent),
        exp: Math.max(1, share(player.exp, expPercent)),
        attacks: [{ text: `swings ${pronoun === 'she' ? 'her' : 'his'} ${weapon} at you`, power: player.strength + gear.weapon }],
        kill: '',
        after: {},
    };
}

const share = (amount: number, percent: number): number => Math.trunc((amount * percent) / 100);

export function attack<F extends FlagRecord, W extends WorldRecord = WorldRecord>({
    realm,
    store,
    days,
    world,
    items,
    me,
    now = Date.now,
    fightsPerDay = FIGHTS_PER_DAY,
    goldPercent = PVP_GOLD_PERCENT,
    expPercent = PVP_EXP_PERCENT,
}: Pvp<F, W>): Script<F, W> {
    return async (g) => {
        if (world.isSafe(g.screenNumber)) {
            g.write('{yellow}No fighting here: this is a safe place.');
            return;
        }

        const near = realm.near(me.id);
        if (!near.length) {
            g.write("{yellow}There's no one close enough to fight.");
            return;
        }

        if (days.fights(me.id) >= fightsPerDay) {
            g.write("{yellow}You've fought enough for one day.");
            return;
        }

        g.cls();
        g.print('{lightred}Fight whom?', '');
        const picked = await g.choice([...near.map(({ name }) => escapeMarkup(name)), 'No one']);
        const target = near[picked];
        if (!target) {
            return;
        }

        const them = target.game.playing;
        const name = escapeMarkup(target.name);
        if (them.hp <= 1) {
            g.print('', `{yellow}${name} is in no state to fight.`);
            await g.key();
            return;
        }

        days.fought(me.id);
        realm.toMember(target.accountId, `{lightred}${escapeMarkup(me.name)} attacks you!`);
        const monster = asMonster(target.name, them, items, { goldPercent, expPercent });
        let lost = 0;
        const result = await g.fight(monster, {
            defeat: (player) => {
                lost = share(player.gold, goldPercent);
                player.gold -= lost;
                player.hp = 1;
                return `${name} beats you, and takes $${lost}.`;
            },
            victory: `{green}You beat {lightred}${name}{green}!  You take {yellow}$${monster.gold}{green} and get {white}${monster.exp}{green} Experience.`,
        });

        // What the fight comes to is for the target's game as it is now: they
        // may have left (and even come back, with a new game) meanwhile.
        const theirs = realm.gameOf(target.accountId);
        const current = theirs?.inProgress ? theirs.playing : null;
        const at = now();
        if (result === 'won') {
            // (They can only lose what they have, if they're still here.)
            const taken = current ? Math.min(monster.gold, current.gold) : 0;
            g.gold -= monster.gold - taken;
            if (current) {
                current.gold -= taken;
                current.hp = 1;
            }
            realm.toMember(target.accountId, `{lightred}${escapeMarkup(me.name)} beat you, and took $${taken}.`);
            store.addNews(`{lightred}${escapeMarkup(me.name)} beat ${name} in a fight.`, at);
        } else if (result === 'lost') {
            if (current) {
                current.gold += lost;
            }
            realm.toMember(target.accountId, `{lightgreen}You beat off ${escapeMarkup(me.name)}'s attack, and took $${lost}.`);
        } else {
            realm.toMember(target.accountId, `{yellow}${escapeMarkup(me.name)} attacked you, then ran away.`);
        }

        if (theirs && current) {
            store.savePlayer(target.accountId, current);
            // (Their gold and hitpoints are on their status line.)
            theirs.refresh();
        }
    };
}
