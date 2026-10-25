// The realm: who's playing on this server and where, so that each player
// sees the others on their screen, hears when someone arrives or leaves,
// can talk to them, and can see who's about (P) and how everyone ranks (L).
//
// The server is one process, so there are no locks: a member's game is
// told about changes (Game.othersChanged, Game.notify) and draws them when
// it's next waiting for a key.

import type { Figure, Game } from '@fq2js/engine/game';
import type { FlagRecord } from '@fq2js/engine/player';
import { escapeMarkup } from '@fq2js/engine/text';

// Where a player is.
export interface Place {
    screen: number;
    x: number;
    y: number;
}

export interface Member<F extends FlagRecord> {
    name: string;
    // Until their game has begun, it isn't there; until they've been placed
    // on the map, nor is their place.
    game: Game<F> | null;
    place: Place | null;
}

// How other players look on the map.
export const OTHER_PLAYER = { ch: '☻', fg: 11 } as const;
// How soon a player can say (or yell) something again.
export const CHAT_WAIT = 1000;

export class Realm<F extends FlagRecord> {
    private readonly members = new Map<number, Member<F>>();
    // When each member last said something.
    private readonly lastSaid = new Map<number, number>();
    private readonly now: () => number;

    public constructor({ now = Date.now }: { now?(): number } = {}) {
        this.now = now;
    }

    // Takes an account into the realm; false if it's in already (playing
    // somewhere else).
    public claim(accountId: number, name: string): boolean {
        if (this.members.has(accountId)) {
            return false;
        }

        this.members.set(accountId, { name, game: null, place: null });
        return true;
    }

    // The account's game has begun: everyone else is told they're here.
    public attach(accountId: number, game: Game<F>): void {
        const member = this.members.get(accountId);
        if (!member) {
            return;
        }

        member.game = game;
        this.tellOthers(accountId, `{lightcyan}${escapeMarkup(member.name)} enters the realm.`);
    }

    // The account has gone: they disappear from wherever they were.
    public release(accountId: number): void {
        const member = this.members.get(accountId);
        if (!member) {
            return;
        }

        this.members.delete(accountId);
        this.lastSaid.delete(accountId);
        if (member.game) {
            this.tellOthers(accountId, `{lightcyan}${escapeMarkup(member.name)} leaves the realm.`);
        }

        if (member.place) {
            this.changed(member.place.screen);
        }
    }

    // A member is somewhere new: whoever can see where they were, or where
    // they are now, redraws.
    public moved(accountId: number, { screen, x, y }: Place): void {
        const member = this.members.get(accountId);
        if (!member) {
            return;
        }

        const before = member.place;
        member.place = { screen, x, y };
        this.changed(screen, accountId);
        if (before && before.screen !== screen) {
            this.changed(before.screen, accountId);
        }
    }

    // The other players on a screen, as a member sees them.
    public figures(accountId: number, screen: number): Figure[] {
        const figures: Figure[] = [];
        for (const [id, { place }] of this.members) {
            if (id !== accountId && place?.screen === screen) {
                figures.push({ x: place.x, y: place.y, ...OTHER_PLAYER });
            }
        }
        return figures;
    }

    // Everyone playing, by name, with where they are (if they've a place yet).
    public online(): { accountId: number; name: string; place: Place | null }[] {
        return [...this.members]
            .filter(([, { game }]) => game !== null)
            .map(([accountId, { name, place }]) => ({ accountId, name, place }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ---- Talking

    // Whether the member may say something now (not too soon after the last
    // time); if so, now is the last time.
    public maySpeak(accountId: number): boolean {
        const now = this.now();
        const last = this.lastSaid.get(accountId);
        if (last !== undefined && now - last < CHAT_WAIT) {
            return false;
        }

        this.lastSaid.set(accountId, now);
        return true;
    }

    // Tells the others on the member's screen (the text is already markup).
    public toScreen(accountId: number, text: string): number {
        const screen = this.members.get(accountId)?.place?.screen;
        let heard = 0;
        for (const [id, { game, place }] of this.members) {
            if (id !== accountId && game && place && place.screen === screen) {
                game.notify(text);
                heard++;
            }
        }
        return heard;
    }

    // Tells everyone else in the realm.
    public toEveryone(accountId: number, text: string): void {
        this.tellOthers(accountId, text);
    }

    // Tells one member, if they're in the realm; false if they aren't.
    public toMember(accountId: number, text: string): boolean {
        const game = this.members.get(accountId)?.game;
        game?.notify(text);
        return game !== undefined && game !== null;
    }

    public get size(): number {
        return this.members.size;
    }

    private tellOthers(accountId: number, text: string): void {
        for (const [id, { game }] of this.members) {
            if (id !== accountId) {
                game?.notify(text);
            }
        }
    }

    // Everyone else on the screen redraws the players on it.
    private changed(screen: number, except?: number): void {
        for (const [id, { game, place }] of this.members) {
            if (id !== except && place?.screen === screen) {
                game?.othersChanged();
            }
        }
    }
}
