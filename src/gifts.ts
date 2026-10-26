// Giving and trading: G offers gold or an item to a player next to you; A
// shows your latest offer, to accept or refuse. Nothing changes hands until
// it's accepted, and then only if the giver is still in the realm with what
// they offered. An offer lasts two minutes; quest items can't be given.

import { count, take, type ItemCatalogue } from '@fq2ts/engine/items';
import type { FlagRecord } from '@fq2ts/engine/player';
import type { Script } from '@fq2ts/engine/script';
import type { WorldRecord } from '@fq2ts/engine/shared';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { Speaker } from './talk.ts';

export const OFFER_SECONDS = 120;

interface Offer {
    from: Speaker;
    // Gold, or one of an item.
    gold: number;
    item: string | null;
    until: number;
}

export class Gifts<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    private readonly realm: Realm<F, W>;
    private readonly store: Store;
    private readonly items: ItemCatalogue;
    private readonly now: () => number;
    // The offer waiting for each player (one: a new one replaces it).
    private readonly offers = new Map<number, Offer>();

    public constructor({ realm, store, items, now = Date.now }: { realm: Realm<F, W>; store: Store; items: ItemCatalogue; now?(): number }) {
        this.realm = realm;
        this.store = store;
        this.items = items;
        this.now = now;
    }

    // A player has left: offers to them, and from them, go.
    public forget(accountId: number): void {
        this.offers.delete(accountId);
        for (const [to, offer] of this.offers) {
            if (offer.from.id === accountId) {
                this.offers.delete(to);
            }
        }
    }

    public get size(): number {
        return this.offers.size;
    }

    // What an offer is, in words: "50 gold", "a Stick".
    private what({ gold, item }: Pick<Offer, 'gold' | 'item'>): string {
        return item === null ? `${gold} gold` : `a ${this.items.get(item).name}`;
    }

    // G: offer something to a player next to you.
    public give(me: Speaker): Script<F, W> {
        return async (g) => {
            const near = this.realm.near(me.id);
            if (!near.length) {
                g.write("{yellow}There's no one close enough to give anything to.");
                return;
            }

            g.cls();
            g.print('{lightgreen}Give to whom?', '');
            const chosen = near[await g.choice([...near.map(({ name }) => escapeMarkup(name)), 'No one'])];
            if (!chosen) {
                return;
            }

            const giftable = g.inventory.filter(({ item }) => item.kind !== 'quest');
            g.cls();
            g.print(`{lightgreen}Give ${escapeMarkup(chosen.name)} what?`, '');
            const options = [`Gold (you have ${g.gold})`, ...giftable.map(({ item, count: n }) => `${item.name}${n > 1 ? ` (you have ${n})` : ''}`), 'Never mind'];
            const picked = await g.choice(options);
            if (picked < 0 || picked === options.length - 1) {
                return;
            }

            let gift: Pick<Offer, 'gold' | 'item'>;
            if (picked === 0) {
                g.cls();
                g.print(`{white}How much gold? {gray}(You have ${g.gold}.)`);
                const gold = await g.number({ x: 1, y: 2, length: 10 });
                if (gold < 1 || gold > g.gold) {
                    g.print('', gold < 1 ? '{yellow}Never mind, then.' : "{yellow}You haven't that much.");
                    await g.key();
                    return;
                }
                gift = { gold, item: null };
            } else {
                const entry = giftable[picked - 1];
                if (!entry) {
                    return;
                }
                gift = { gold: 0, item: entry.item.id };
            }

            // (They may have moved on while this one chose.)
            const target = this.realm.near(me.id).find(({ accountId, game }) => accountId === chosen.accountId && game === chosen.game);
            if (!target) {
                g.print('', `{yellow}${escapeMarkup(chosen.name)} has moved on.`);
                await g.key();
                return;
            }

            this.offers.set(target.accountId, { from: me, ...gift, until: this.now() + OFFER_SECONDS * 1000 });
            const what = this.what(gift);
            this.realm.toMember(target.accountId, `{lightgreen}${escapeMarkup(me.name)} offers you ${what}. (A to accept or refuse it.)`);
            g.print('', `{lightgreen}You offer ${escapeMarkup(target.name)} ${what}.`);
            await g.key();
        };
    }

    // A: the offer waiting for you, to accept or refuse.
    public accept(me: Speaker): Script<F, W> {
        return async (g) => {
            const offer = this.offers.get(me.id);
            if (!offer || offer.until < this.now()) {
                this.offers.delete(me.id);
                g.write('{yellow}No one has offered you anything.');
                return;
            }

            const what = this.what(offer);
            const from = escapeMarkup(offer.from.name);
            g.cls();
            g.print(`{lightgreen}${from} offers you ${what}.`, '');
            const yes = (await g.choice(['Accept it', 'Refuse it'])) === 0;
            // (The offer may have changed, or gone, while this one chose.)
            if (this.offers.get(me.id) !== offer) {
                g.print('', '{yellow}That offer has gone.');
                await g.key();
                return;
            }
            this.offers.delete(me.id);
            if (!yes) {
                this.realm.toMember(offer.from.id, `{yellow}${escapeMarkup(me.name)} turned down ${what}.`);
                return;
            }

            // The giver, as they are now, must still have it to give.
            const theirs = this.realm.gameOf(offer.from.id);
            const giver = theirs?.inProgress ? theirs.playing : null;
            const has = giver !== null && (offer.item === null ? giver.gold >= offer.gold : count(giver, offer.item) >= 1);
            if (!theirs || !giver || !has) {
                g.print('', `{yellow}${from} hasn't ${what} to give any more.`);
                await g.key();
                return;
            }

            if (offer.item === null) {
                giver.gold -= offer.gold;
                g.gold += offer.gold;
            } else {
                take(giver, offer.item, 1);
                g.give(offer.item);
            }
            this.store.savePlayer(offer.from.id, giver);
            theirs.refresh();
            this.realm.toMember(offer.from.id, `{lightgreen}${escapeMarkup(me.name)} took ${what} from you. That was kind.`);
            g.print('', `{lightgreen}You take ${what} from ${from}.`);
            await g.key();
        };
    }
}
