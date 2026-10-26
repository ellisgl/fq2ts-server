// The admin menu (!), for accounts marked admin: kick a player out of the
// realm, ban or unban an account, or tell everyone something. Every action
// is logged. (bun run admin does the same from the command line, and makes
// admins.)

import type { FlagRecord } from '@fq2js/engine/player';
import type { Script } from '@fq2js/engine/script';
import type { WorldRecord } from '@fq2js/engine/shared';
import { escapeMarkup } from '@fq2js/engine/text';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { Speaker } from './talk.ts';

export const REASON_LENGTH = 60;

interface Admin<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    store: Store;
    me: Speaker;
    // Ends an account's connection, with a last message for them.
    kick(accountId: number, message: string): void;
    log(line: string): void;
}

export function adminMenu<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, store, me, kick, log }: Admin<F, W>): Script<F, W> {
    return async (g) => {
        g.cls();
        g.print('{lightmagenta}The admin menu', '');
        const choice = await g.choice(['Kick a player out of the realm', 'Ban a player', 'Lift a ban', 'Tell everyone something', 'Never mind']);

        // A line of text under the menu; null if Escape.
        const ask = async (question: string): Promise<string | null> => {
            g.cls();
            g.print(`{white}${question}`);
            return (await g.ask({ x: 1, y: 2, length: REASON_LENGTH + 1 }))?.trim() ?? null;
        };
        const done = async (text: string): Promise<void> => {
            g.print('', text);
            await g.key();
        };

        if (choice === 0) {
            const others = realm.online().filter(({ accountId }) => accountId !== me.id);
            if (!others.length) {
                await done("{yellow}There's no one else in the realm.");
                return;
            }

            g.cls();
            g.print('{white}Kick whom?', '');
            const picked = others[await g.choice([...others.map(({ name }) => escapeMarkup(name)), 'No one'])];
            if (!picked) {
                return;
            }

            const reason = await ask(`Why is ${escapeMarkup(picked.name)} being kicked? (They're told.)`);
            if (reason === null) {
                return;
            }

            kick(picked.accountId, `You were removed from the realm by ${me.name}${reason ? `: ${reason}` : '.'}`);
            log(`${me.name} kicked ${picked.name}${reason ? `: ${reason}` : '.'}`);
            await done(`{lightgreen}${escapeMarkup(picked.name)} has been kicked.`);
        } else if (choice === 1) {
            const name = await ask('Ban whom? (Their name.)');
            if (!name) {
                return;
            }

            const account = store.account(name);
            if (!account) {
                await done("{yellow}There's no one by that name.");
                return;
            }
            if (account.id === me.id) {
                await done("{yellow}You can't ban yourself.");
                return;
            }

            const reason = await ask(`Why is ${escapeMarkup(account.name)} banned? (They're told when they try to come in.)`);
            if (!reason) {
                return;
            }

            store.setBanned(account.id, reason);
            log(`${me.name} banned ${account.name}: ${reason}`);
            if (realm.gameOf(account.id)) {
                kick(account.id, `You are banned from the realm: ${reason}`);
            }
            await done(`{lightgreen}${escapeMarkup(account.name)} is banned.`);
        } else if (choice === 2) {
            const name = await ask('Lift whose ban? (Their name.)');
            if (!name) {
                return;
            }

            const account = store.account(name);
            if (!account || account.banned === null) {
                await done("{yellow}There's no one banned by that name.");
                return;
            }

            store.setBanned(account.id, null);
            log(`${me.name} lifted ${account.name}'s ban.`);
            await done(`{lightgreen}${escapeMarkup(account.name)} can come back.`);
        } else if (choice === 3) {
            const text = await ask('Tell everyone:');
            if (!text) {
                return;
            }

            realm.toEveryone(me.id, `{lightmagenta}${escapeMarkup(me.name)} (admin): ${escapeMarkup(text)}`);
            log(`${me.name} told everyone: ${text}`);
            await done('{lightgreen}Everyone in the realm has been told.');
        }
    };
}
