// Days, on the server: at midnight (server time) a new day dawns. Each
// player's daily things start again: their fights against other players,
// and the content's daily flags (FQ2's one drink a day). Players in the
// realm then are reset at once; the others when they next arrive.

import type { Content } from '@fq2ts/engine/game';
import type { FlagRecord, Player } from '@fq2ts/engine/player';
import type { WorldRecord } from '@fq2ts/engine/shared';
import { record } from '@fq2ts/engine/validate';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';

// The day it is at a time, by the server's clock: "2026-10-25".
export function dayOf(at: number): string {
    const d = new Date(at);
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export const NEW_DAY = '{yellow}A new day dawns in the realm.';

export class Days<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    private readonly store: Store;
    private readonly content: Content<F, W>;
    private readonly realm: Realm<F, W>;
    private readonly now: () => number;
    private day: string;

    public constructor({ store, content, realm, now = Date.now }: { store: Store; content: Content<F, W>; realm: Realm<F, W>; now?(): number }) {
        this.store = store;
        this.content = content;
        this.realm = realm;
        this.now = now;
        this.day = store.meta('day') ?? '';
        this.check();
    }

    public get today(): string {
        return this.day;
    }

    // Starts a new day if it's one now (called every so often; and when the
    // server starts, in case it was down at midnight).
    public check(): void {
        const today = dayOf(this.now());
        if (today === this.day) {
            return;
        }

        const first = this.day === '';
        this.day = today;
        this.store.setMeta('day', today);
        if (first) {
            return;
        }

        this.store.addNews(NEW_DAY, this.now());
        for (const { accountId } of this.realm.online()) {
            const game = this.realm.gameOf(accountId);
            if (game?.inProgress) {
                this.resetFlags(game.playing);
                this.store.setPlayerDay(accountId, today, 0);
                game.notify(NEW_DAY);
            }
        }
    }

    // A player arriving: if their day is an old one, their daily things
    // start again (in their saved player, before it's loaded).
    public arrive(accountId: number): void {
        const theirs = this.store.playerDay(accountId);
        if (theirs?.day === this.day) {
            return;
        }

        this.store.setPlayerDay(accountId, this.day, 0);
        const saved = this.store.loadPlayer(accountId);
        if (saved === null) {
            return;
        }

        try {
            // (record copies what it's given, so the save is put back together.)
            const save = record(saved, 'save');
            const flags = record(save['flags'], 'save.flags');
            for (const name of this.content.daily ?? []) {
                flags[name] = this.content.start.flags[name];
            }
            this.store.savePlayer(accountId, { ...save, flags });
        } catch {
            // A save without flags has nothing to reset (loading it says
            // what's wrong with it).
        }
    }

    // How many fights the player has had today.
    public fights(accountId: number): number {
        const theirs = this.store.playerDay(accountId);
        return theirs?.day === this.day ? theirs.fights : 0;
    }

    public fought(accountId: number): void {
        this.store.setPlayerDay(accountId, this.day, this.fights(accountId) + 1);
    }

    private resetFlags(player: Player<F>): void {
        for (const name of this.content.daily ?? []) {
            player.flags[name] = this.content.start.flags[name];
        }
    }
}
