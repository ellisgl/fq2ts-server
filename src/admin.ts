// The admin menu (!), for accounts marked admin: kick a player out of the
// realm, ban or unban an account or an address, or tell everyone
// something. Every action
// is logged. (bun run admin does the same from the command line, and makes
// admins.)

import type { FlagRecord } from '@fq2ts/engine/player';
import type { Script } from '@fq2ts/engine/script';
import type { WorldRecord } from '@fq2ts/engine/shared';
import { escapeMarkup } from '@fq2ts/engine/text';
import type { Realm } from './realm.ts';
import type { Store } from './store.ts';
import type { Speaker } from './talk.ts';
import { isLocal, normalAddress } from './guard.ts';

export const REASON_LENGTH = 60;

interface Admin<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    realm: Realm<F, W>;
    store: Store;
    me: Speaker;
    // Ends an account's connection, or every connection from an address,
    // with a last message for them.
    kick(accountId: number, message: string): void;
    kickAddress(address: string, message: string): void;
    log(line: string): void;
}

// What an address can be: digits, letters a-f, dots and colons (IPv4 or IPv6).
const ADDRESS = /^[0-9a-f.:]+$/i;

export function adminMenu<F extends FlagRecord, W extends WorldRecord = WorldRecord>({ realm, store, me, kick, kickAddress, log }: Admin<F, W>): Script<F, W> {
    return async (g) => {
        g.cls();
        g.print('{lightmagenta}The admin menu', '');
        const choice = await g.choice([
            'Kick a player out of the realm',
            'Ban a player',
            'Ban an address',
            'Lift a ban on a player',
            'Lift a ban on an address',
            'Tell everyone something',
            'Never mind',
        ]);

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
        // Bans an address and puts out whoever's connected from it.
        const banAddress = (address: string, reason: string): void => {
            store.banAddress(address, reason);
            log(`${me.name} banned the address ${address}: ${reason}`);
            kickAddress(address, `This address is banned from the realm: ${reason}`);
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

            // Their address too? (Not this machine's: behind a proxy we don't
            // trust, everyone's comes from it.)
            const address = account.lastAddress;
            if (address !== null && !isLocal(address)) {
                g.cls();
                g.print(`{white}Ban the address ${escapeMarkup(account.name)} last came from, too?`, '');
                if ((await g.choice(['Just the account', `The account and ${address}`])) === 1) {
                    banAddress(address, reason);
                }
            }
            await done(`{lightgreen}${escapeMarkup(account.name)} is banned.`);
        } else if (choice === 2) {
            const typed = await ask('Ban which address?');
            if (!typed) {
                return;
            }

            const address = normalAddress(typed);
            if (!ADDRESS.test(address)) {
                await done("{yellow}That isn't an address (like 203.0.113.9).");
                return;
            }
            if (isLocal(address)) {
                await done("{yellow}That's this machine. (Behind a proxy, everyone looks like it: set FQ2_TRUST_PROXY.)");
                return;
            }

            const reason = await ask(`Why is ${address} banned? (Whoever comes from it is told.)`);
            if (!reason) {
                return;
            }

            banAddress(address, reason);
            await done(`{lightgreen}${address} is banned.`);
        } else if (choice === 3) {
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
        } else if (choice === 4) {
            const typed = await ask('Lift the ban on which address?');
            if (!typed) {
                return;
            }

            const address = normalAddress(typed);
            if (!store.unbanAddress(address)) {
                await done("{yellow}That address isn't banned.");
                return;
            }

            log(`${me.name} lifted the ban on ${address}.`);
            await done(`{lightgreen}${address} can come back.`);
        } else if (choice === 5) {
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
