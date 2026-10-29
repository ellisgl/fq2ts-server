// Fights between players (H): next to someone on your screen, out on the
// map, you can attack them. You fight them as you would a monster made of
// their stats; they're told at once, and of how it ended. The loser gives
// the winner a share of their gold (half, by default) and is left on 1
// hitpoint, and the winner gets some experience. Not on safe screens
// (interiors, and screens marked safe), not against someone already beaten
// (1 hitpoint), and only so many fights a day.
//
// Players who've left the realm sleep where they were, unless they took a
// room at an inn, and can be attacked there, safe screens too (as in
// LORD II): they're sent a letter saying what happened.

import { gearOf, type ItemCatalogue } from '@fq2ts/engine/items';
import type { FightResult, Monster } from '@fq2ts/engine/combat';
import type { Game } from '@fq2ts/engine/game';
import type { FlagRecord, Player } from '@fq2ts/engine/player';
import type { Script } from '@fq2ts/engine/script';
import type { WorldRecord } from '@fq2ts/engine/shared';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { World } from '@fq2ts/engine/world';
import type { Days } from './days.ts';
import type { Realm } from './realm.ts';
import type { AwayPlayer, Store } from './store.ts';
import type { Speaker } from './talk.ts';

// Unless the server's rules say otherwise: fights a day, and the shares of
// the loser's gold and experience the winner gets, in percent.
export const FIGHTS_PER_DAY = 3;
export const PVP_GOLD_PERCENT = 50;
export const PVP_EXP_PERCENT = 10;

interface Pvp<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    // A player's save, as a player (null if they have none; by default,
    // no one's is read, and players who are away can't be fought).
    restore?(accountId: number): Player<F> | null;
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
    restore = () => null,
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
        // (On safe screens, only those sleeping out in the open.)
        const safe = world.isSafe(g.screenNumber);
        const near = safe ? [] : realm.near(me.id);
        const away = realm.nearAway(me.id);
        if (!near.length && !away.length) {
            g.write(safe ? '{yellow}No fighting here: this is a safe place.' : "{yellow}There's no one close enough to fight.");
            return;
        }

        if (days.fights(me.id) >= fightsPerDay) {
            g.write("{yellow}You've fought enough for one day.");
            return;
        }

        g.cls();
        g.print('{lightred}Fight whom?', '');
        const picked = await g.choice([...near.map(({ name }) => escapeMarkup(name)), ...away.map(({ name }) => `${escapeMarkup(name)} (sleeping)`), 'No one']);
        const chosen = near[picked];
        const sleeper = away[picked - near.length];
        if (chosen) {
            await fightOnline(chosen);
        } else if (sleeper) {
            await fightAway(sleeper);
        }

        async function fightOnline(chosen: { accountId: number; name: string; game: Game<F, W> }): Promise<void> {
            // While the player chose, the target may have walked off, or into a
            // scene or a fight of their own: they must still be next to them,
            // waiting on the map.
            const name = escapeMarkup(chosen.name);
            const target = realm.near(me.id).find(({ accountId, game }) => accountId === chosen.accountId && game === chosen.game);
            if (!target) {
                g.print('', `{yellow}${name} has moved on.`);
                await g.key();
                return;
            }

            const them = target.game.playing;
            if (them.hp <= 1) {
                g.print('', `{yellow}${name} is in no state to fight.`);
                await g.key();
                return;
            }

            days.fought(me.id);
            realm.toMember(target.accountId, `{lightred}${escapeMarkup(me.name)} attacks you!`);
            const { result, taken, lost } = await fight(target.accountId, target.name, them);
            if (result === 'won') {
                realm.toMember(target.accountId, `{lightred}${escapeMarkup(me.name)} beat you, and took $${taken}.`);
            } else if (result === 'lost') {
                realm.toMember(target.accountId, `{lightgreen}You beat off ${escapeMarkup(me.name)}'s attack, and took $${lost}.`);
            } else {
                realm.toMember(target.accountId, `{yellow}${escapeMarkup(me.name)} attacked you, then ran away.`);
            }
        }

        async function fightAway(chosen: AwayPlayer): Promise<void> {
            // They may have come back meanwhile, or another may have got to
            // them first.
            const name = escapeMarkup(chosen.name);
            const still = realm.nearAway(me.id).some(({ accountId }) => accountId === chosen.accountId);
            const them = still ? restore(chosen.accountId) : null;
            if (!them) {
                g.print('', `{yellow}${name} isn't there any more.`);
                await g.key();
                return;
            }

            if (them.hp <= 1) {
                g.print('', `{yellow}${name} is in no state to fight.`);
                await g.key();
                return;
            }

            days.fought(me.id);
            // (Attacking someone asleep is no good deed.)
            g.alignment -= 1;
            const { result, taken, lost } = await fight(chosen.accountId, chosen.name, them);
            const letter = result === 'won'
                ? `I found you sleeping, and beat you. I took $${taken}.`
                : result === 'lost'
                    ? `I found you sleeping and attacked you, but you beat me off. You took $${lost}.`
                    : 'I found you sleeping and attacked you, then thought better of it and ran.';
            store.sendLetter(chosen.accountId, me.name, letter, now());
            realm.toMember(chosen.accountId, `{lightgreen}A letter from ${escapeMarkup(me.name)} has come. (W to read it.)`);
        }

        // The fight, and what it comes to: for the target's game as it is
        // now (they may have left, or come back, meanwhile), or their save.
        async function fight(accountId: number, targetName: string, them: Player<F>): Promise<{ result: FightResult; taken: number; lost: number }> {
            const name = escapeMarkup(targetName);
            const monster = asMonster(targetName, them, items, { goldPercent, expPercent });
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

            const theirs = realm.gameOf(accountId);
            const playing = theirs?.inProgress ? theirs.playing : null;
            const current = playing ?? restore(accountId);
            const at = now();
            let taken = 0;
            if (result === 'won') {
                // (They can only lose what they have.)
                taken = current ? Math.min(monster.gold, current.gold) : 0;
                g.gold -= monster.gold - taken;
                if (current) {
                    current.gold -= taken;
                    current.hp = 1;
                }
                store.addNews(`{lightred}${escapeMarkup(me.name)} beat ${name} in a fight.`, at);

                // The bounties on their head are the winner's.
                const bounty = store.claimBounties(accountId);
                if (bounty > 0) {
                    g.gold += bounty;
                    g.write(`{yellow}You collect the $${bounty} bounty on ${name}'s head!`);
                    store.addNews(`{yellow}${escapeMarkup(me.name)} collected the $${bounty} bounty on ${name}'s head.`, at);
                }
            } else if (result === 'lost' && current) {
                current.gold += lost;
            }

            if (current) {
                store.savePlayer(accountId, current, { played: playing !== null });
            }
            // (Their gold and hitpoints are on their status line.)
            theirs?.refresh();
            return { result, taken, lost };
        }
    };
}
