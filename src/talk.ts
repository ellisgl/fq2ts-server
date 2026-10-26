// Talking, on the server: T says something to the players on your screen,
// Y yells it to everyone, W reads and writes letters, D shows the news.
// Everything a player types is escaped before anyone sees it, so it can't
// colour (or move about) anyone else's screen.

import type { FlagRecord } from '@fq2ts/engine/player';
import type { Monster } from '@fq2ts/engine/combat';
import type { Script } from '@fq2ts/engine/script';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { WorldRecord } from '@fq2ts/engine/shared';

// The longest thing that can be said, and a letter's lines.
export const SAY_LENGTH = 60;
export const LETTER_LINES = 4;
export const LETTER_WIDTH = 70;
// Letters one visit can send (so no one can fill someone's mailbox).
export const LETTERS_PER_VISIT = 10;

// Who's talking: their account, and what they're called.
export interface Speaker {
    id: number;
    name: string;
}

interface Talk<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    store: Store;
    me: Speaker;
    now?(): number;
    // Letters one visit can send (default: LETTERS_PER_VISIT).
    lettersPerVisit?: number;
}

const NOT_SO_FAST = '{yellow}Not so fast! Wait a moment before saying more.';

// T: to everyone on this screen.
export function talk<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, me }: Talk<F, W>): Script<F, W> {
    return async (g) => {
        const said = (await g.askLine('Say:', SAY_LENGTH))?.trim();
        if (!said) {
            return;
        }

        if (!realm.maySpeak(me.id)) {
            g.write(NOT_SO_FAST);
            return;
        }

        const words = escapeMarkup(said);
        const heard = realm.toScreen(me.id, `{white}${escapeMarkup(me.name)} says: {gray}"${words}"`);
        g.write(heard ? `{white}You say: {gray}"${words}"` : `{gray}You say "${words}", but no one is here to hear it.`);
    };
}

// Y: to everyone in the realm.
export function yell<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, me }: Talk<F, W>): Script<F, W> {
    return async (g) => {
        const said = (await g.askLine('Yell:', SAY_LENGTH))?.trim();
        if (!said) {
            return;
        }

        if (!realm.maySpeak(me.id)) {
            g.write(NOT_SO_FAST);
            return;
        }

        const words = escapeMarkup(said);
        realm.toEveryone(me.id, `{yellow}${escapeMarkup(me.name)} yells: "${words}"`);
        g.write(`{yellow}You yell: "${words}"`);
    };
}

// W: the player's letters, and writing one to another player.
export function mail<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, store, me, now = Date.now, lettersPerVisit = LETTERS_PER_VISIT }: Talk<F, W>): Script<F, W> {
    let sent = 0;
    return async (g) => {
        const letters = store.letters(me.id);
        const unread = letters.filter((letter) => !letter.read).length;
        g.cls();
        g.print('{yellow}Your mail', '');
        const choice = await g.choice([`Read your letters (${letters.length}, ${unread} new)`, 'Write a letter', 'Never mind']);
        if (choice === 0) {
            const lines = letters.flatMap(({ from, text, sentAt, read }) => [
                `{yellow}From ${escapeMarkup(from)}{gray}, ${when(sentAt)}${read ? '' : ' {lightgreen}(new)'}`,
                ...text.split('\n').map((line) => `{white}${escapeMarkup(line)}`),
                '',
            ]);
            await g.scroll(lines.length ? lines : ['{gray}No letters.'], 'Your letters');
            store.markLettersRead(me.id);
        } else if (choice === 1) {
            if (sent >= lettersPerVisit) {
                g.print('', "{yellow}That's all the letters for this visit.");
                await g.key();
                return;
            }

            if (await writeLetter()) {
                sent++;
            }
        }

        async function writeLetter(): Promise<boolean> {
            g.cls();
            g.print('{yellow}Write a letter', '', '{white}To whom?');
            const name = (await g.ask({ x: 1, y: 4, length: 21 }))?.trim();
            if (!name) {
                return false;
            }

            const to = store.account(name);
            if (!to) {
                g.print('', "{yellow}There's no one by that name.");
                await g.key();
                return false;
            }

            if (to.id === me.id) {
                g.print('', "{yellow}You can't write to yourself.");
                await g.key();
                return false;
            }

            g.print('', `{white}Your letter to ${escapeMarkup(to.name)} {gray}(${LETTER_LINES} lines at most; an empty line ends it, Escape throws it away):`);
            const lines: string[] = [];
            while (lines.length < LETTER_LINES) {
                const line = await g.ask({ x: 1, y: 8 + lines.length, length: LETTER_WIDTH + 1 });
                if (line === null) {
                    return false;
                }
                if (!line.trim()) {
                    break;
                }
                lines.push(line.trimEnd());
            }

            if (!lines.length) {
                return false;
            }

            store.sendLetter(to.id, me.name, lines.join('\n'), now());
            realm.toMember(to.id, `{lightgreen}A letter from ${escapeMarkup(me.name)} has come. (W to read it.)`);
            g.print('', '{lightgreen}Your letter is on its way.');
            await g.key();
            return true;
        }
    };
}

// D: the news, today's and yesterday's.
export function news<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ store, now = Date.now }: Talk<F, W>): Script<F, W> {
    return async (g) => {
        const today = startOfDay(now());
        const yesterday = today - 86_400_000;
        const lines: string[] = [];
        for (const [label, from, to] of [['Today', today, Infinity], ['Yesterday', yesterday, today]] as const) {
            const items = store.news(from).filter(({ at }) => at < to);
            lines.push(`{yellow}${label}`, ...(items.length ? items.map(({ text, at }) => `{gray}${time(at)}  {white}${text}`) : ['{gray}Nothing happened.']), '');
        }
        await g.scroll(lines, 'The daily news');
    };
}

// The news of a fight that was lost: "Ann was beaten by a Tree Frog."
export function lostFight(name: string, monster: Monster): string {
    const article = monster.pronoun !== 'it' ? '' : /^[aeiou]/i.test(monster.name) ? 'an ' : 'a ';
    return `{lightred}${escapeMarkup(name)} was beaten by ${article}${escapeMarkup(monster.name)}.`;
}

const two = (n: number): string => String(n).padStart(2, '0');
const time = (at: number): string => {
    const d = new Date(at);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const when = (at: number): string => {
    const d = new Date(at);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${time(at)}`;
};

function startOfDay(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
