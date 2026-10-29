// Bounty hunters: a player with a price on their head (the bounty board,
// K) is hunted. Now and then, a step onto wild ground away from the safe
// screens brings a hunter out of hiding, made from the player's own
// strength, gear and hitpoints, give or take. If the hunter wins, they
// collect the bounty: it comes off the board, and the news says so. Beat
// them, and their purse is yours.

import { gearOf, type ItemCatalogue } from '@fq2ts/engine/items';
import type { FightResult, Monster } from '@fq2ts/engine/combat';
import type { FlagRecord, Player } from '@fq2ts/engine/player';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { World } from '@fq2ts/engine/world';
import type { Store } from './store.ts';

// Unless the server's rules say otherwise: one step in this many, for a
// player with a bounty on their head.
export const HUNTER_ODDS = 40;

const HUNTERS: readonly { name: string; pronoun: 'he' | 'she'; weapon: string }[] = [
    { name: 'Kael the Tracker', pronoun: 'he', weapon: 'crossbow' },
    { name: 'One-Eyed Rusk', pronoun: 'he', weapon: 'hooked spear' },
    { name: 'Silent Mara', pronoun: 'she', weapon: 'twin daggers' },
    { name: 'the Hound', pronoun: 'he', weapon: 'chain and weights' },
];

// How much stronger (or weaker) than the player a hunter is.
const SCALE = [0.8, 0.9, 1, 1.1, 1.2];

interface Options {
    store: Store;
    world: World;
    items: ItemCatalogue;
    odds?: number;
    random?(): number;
}

export class BountyHunters {
    private readonly options: Options;
    // The hunters sent out, to know them when their fights end.
    private readonly hunters = new WeakSet<Monster>();

    public constructor(options: Options) {
        this.options = options;
    }

    // A hunter, if one comes for this player at this step; null if not.
    public ambush<F extends FlagRecord>(accountId: number, player: Player<F>): Monster | null {
        const { store, world, items, odds = HUNTER_ODDS, random = Math.random } = this.options;
        if (odds <= 0 || world.isSafe(player.screen) || Math.floor(random() * odds) !== 0 || store.bountyOn(accountId) <= 0) {
            return null;
        }

        const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] ?? (list[0] as T);
        const { name, pronoun, weapon } = pick(HUNTERS);
        const gear = gearOf(player, items);
        const hunter: Monster = {
            name,
            says: `"There's a price on your head," says ${name}, raising ${pronoun === 'she' ? 'her' : 'his'} ${weapon}.`,
            pronoun,
            hp: Math.max(1, Math.round(player.maxHp * pick(SCALE))),
            defense: Math.round((player.defense + gear.armour) * pick(SCALE)),
            gold: 20 + Math.floor(random() * 41),
            exp: 10,
            attacks: [{ text: `swings ${pronoun === 'she' ? 'her' : 'his'} ${weapon} at you`, power: Math.max(1, Math.round((player.strength + gear.weapon) * pick(SCALE))) }],
            kill: '',
            after: {},
        };
        this.hunters.add(hunter);
        return hunter;
    }

    // What a fight with a hunter comes to: the news, and the bounty if they
    // won. Returns what to tell the player, or null if `monster` wasn't a
    // hunter.
    public fought(accountId: number, name: string, monster: Monster, result: FightResult, at: number): string | null {
        if (!this.hunters.has(monster)) {
            return null;
        }

        this.hunters.delete(monster);
        const { store } = this.options;
        const who = escapeMarkup(name);
        if (result === 'lost') {
            const bounty = store.claimBounties(accountId);
            store.addNews(`{lightred}${escapeMarkup(monster.name)} caught ${who}, and collected the $${bounty} bounty on their head.`, at);
            return `{lightred}${escapeMarkup(monster.name)} collects the $${bounty} bounty on your head.`;
        }

        if (result === 'won') {
            store.addNews(`{lightgreen}${who} fought off ${escapeMarkup(monster.name)}, a bounty hunter.`, at);
            return '{lightgreen}The bounty hunter is beaten, but the price on your head stands.';
        }

        return '{yellow}You got away from the bounty hunter, for now.';
    }
}
