// One player's connection to the server: the login screen, then the game,
// until they leave or the connection goes.
//
// Every account has an email address, confirmed with a code sent to it
// before the account can play, and one address has one account. A
// forgotten password is reset with another code; changing the address
// takes the password, then a code sent to the new one.

import { draw, escapeMarkup } from '@fq2ts/engine/text';
import { askText, choose } from '@fq2ts/engine/ui';
import { Disconnected, type Terminal } from '@fq2ts/engine/terminal';
import { restorePlayer, type FlagRecord, type Player } from '@fq2ts/engine/player';
import type { ItemCatalogue } from '@fq2ts/engine/items';
import type { Config, Content, Game } from '@fq2ts/engine/game';
import { changedEmail, codeEmail, MAX_EMAIL, validEmail, type CodePurpose, type Mailer } from './mail.ts';
import { CODE_MINUTES, validName, type Account, type Store } from './store.ts';
import type { WorldRecord } from '@fq2ts/engine/shared';

// Wrong passwords before the connection is closed.
const MAX_TRIES = 3;
export const MIN_PASSWORD = 6;
// The longest a password can be typed, and a name (as validName allows).
export const MAX_PASSWORD = 64;
const MAX_NAME = 20;
// How soon another code can be sent for the same thing.
export const RESEND_WAIT = 60_000;
// Emails one connection can ask for (so it can't be used to send lots).
export const MAX_EMAILS = 5;
const CODE_LENGTH = 6;

export interface SessionOptions<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    // Emails (codes) this connection can ask for (default: MAX_EMAILS).
    emailsPerVisit?: number;
    // Where the player is connecting from (kept as the account's last
    // address, for banning it).
    address?: string;
    // Why logging in to this account is shut just now (too many wrong
    // passwords), or null; and a wrong name or password, to count.
    loginShut?(name: string): string | null;
    loginFailed?(name: string): void;
    // Whether this connection's address can make an account now, and that
    // it has; whether an email can go to this recipient now.
    maySignUp?(): boolean;
    signedUp?(): void;
    mayEmail?(to: string): boolean;
    term: Terminal;
    store: Store;
    content: Content<F, W>;
    items: ItemCatalogue;
    config: Config;
    // Makes this connection's game, which saves the player through `autosave`.
    makeGame(account: Account, autosave: (player: Player<F>) => void): Game<F, W>;
    // Marks an account as playing; false if it already is (elsewhere).
    claim(account: Account): boolean;
    release(accountId: number): void;
    log(line: string): void;
    mailer: Mailer;
    // The time, in milliseconds (for tests).
    now?(): number;
    hashPassword?(password: string): Promise<string>;
    verifyPassword?(password: string, hash: string): Promise<boolean>;
}

interface AskOptions {
    mask?: boolean;
    row?: number;
    max?: number;
    note?: string;
    filter?(ch: string): boolean;
}

// Codes are kept as hashes, like passwords (they're short-lived and only
// get a few guesses, so a quick hash will do).
const hashCode = (code: string): string => new Bun.CryptoHasher('sha256').update(code).digest('hex');

// The login box sits in the title screen's menu box.
const BOX = { x: 33, top: 16, width: 17, bottom: 23 };

export class Session<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    private readonly options: SessionOptions<F, W>;
    private readonly term: Terminal;
    // The player being played, to save if the connection goes.
    private playing: { account: Account; game: Game<F, W> } | null = null;
    private wrongPasswords = 0;
    private emailsSent = 0;

    public constructor(options: SessionOptions<F, W>) {
        this.options = options;
        this.term = options.term;
    }

    // Runs the session to the end: the player leaves, gets too many
    // passwords wrong, or disconnects. Never throws.
    public async run(): Promise<void> {
        try {
            await this.frontDoor();
        } catch (error) {
            if (!(error instanceof Disconnected)) {
                this.options.log(`Session error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
                this.notice('{lightred}Something went wrong. Sorry! Your game was saved.');
            }
        } finally {
            this.save();
        }
    }

    // Saves the player being played, if any (on disconnects, errors and
    // server shutdown).
    public save(): void {
        // (A game that failed before it began has no player.)
        if (this.playing?.game.inProgress) {
            this.options.store.savePlayer(this.playing.account.id, this.playing.game.playing);
        }
    }

    private async frontDoor(): Promise<void> {
        for (;;) {
            const choice = await this.menu(['Log in', 'New player', 'Forgot password', 'Leave this place']);
            let account: Account | null = null;
            if (choice === 0) {
                account = await this.logIn();
            } else if (choice === 1) {
                account = await this.signUp();
            } else if (choice === 2) {
                await this.resetPassword();
            } else {
                return;
            }

            if (account) {
                await this.play(account);
            }

            if (this.wrongPasswords >= MAX_TRIES) {
                this.notice('{lightred}Too many wrong passwords. Goodbye.');
                return;
            }
        }
    }

    // ---- Accounts

    private async logIn(): Promise<Account | null> {
        const name = await this.ask('Name:', { max: MAX_NAME });
        if (name === null) {
            return null;
        }

        const password = await this.ask('Password:', { mask: true, row: 2, max: MAX_PASSWORD });
        if (password === null) {
            return null;
        }

        const shut = this.options.loginShut?.(name.trim()) ?? null;
        if (shut !== null) {
            await this.pause(`{lightred}${shut}`);
            return null;
        }

        const account = this.options.store.account(name.trim());
        if (!account) {
            this.wrongPasswords++;
        }

        if (!account || !(await this.verify(password, account))) {
            this.options.loginFailed?.(name.trim());
            await this.pause('{lightred}Wrong name or password.');
            return null;
        }

        if (account.banned !== null) {
            this.options.log(`${account.name} tried to come in, but is banned.`);
            await this.pause(`{lightred}You are banned from the realm: ${escapeMarkup(account.banned)}`);
            return null;
        }

        return account.emailConfirmed || (await this.confirmEmail(account)) ? account : null;
    }

    // Whether this is the account's password (counting wrong ones).
    private async verify(password: string, account: Account): Promise<boolean> {
        const verify = this.options.verifyPassword ?? ((p: string, h: string) => Bun.password.verify(p, h));
        if (await verify(password, account.passwordHash)) {
            return true;
        }

        this.wrongPasswords++;
        return false;
    }

    private async signUp(): Promise<Account | null> {
        const { store } = this.options;
        if (this.options.maySignUp?.() === false) {
            await this.pause('{yellow}Too many new accounts from your address. Please try later.');
            return null;
        }

        let name: string | null = null;
        while (name === null) {
            const answer = await this.ask('Your name:', { max: MAX_NAME });
            if (answer === null) {
                return null;
            }

            const wanted = answer.trim();
            if (!validName(wanted)) {
                await this.pause("{yellow}2-20 letters, digits, spaces and ' - . please.");
            } else if (store.account(wanted)) {
                await this.pause('{yellow}Someone already has that name.');
            } else {
                name = wanted;
            }
        }

        const password = await this.askNewPassword(2);
        if (password === null) {
            return null;
        }

        const email = await this.askEmail();
        if (email === null) {
            return null;
        }

        const account = store.createAccount(name, await this.hash(password), email);
        if (!account) {
            // Someone took the name while this player was typing.
            await this.pause('{yellow}Someone just took that name. Try another.');
            return null;
        }

        this.options.signedUp?.();
        this.options.log(`New account: ${account.name}`);
        return (await this.confirmEmail(account)) ? account : null;
    }

    // A new password, typed twice; null on Escape.
    private async askNewPassword(row: number): Promise<string | null> {
        for (;;) {
            const first = await this.ask('Password:', { mask: true, row, max: MAX_PASSWORD });
            if (first === null) {
                return null;
            }

            const again = await this.ask('Once more:', { mask: true, row: row + 2, max: MAX_PASSWORD });
            if (again === null) {
                return null;
            }

            if (first.length < MIN_PASSWORD) {
                await this.pause(`{yellow}At least ${MIN_PASSWORD} characters, please.`);
            } else if (first !== again) {
                await this.pause("{yellow}Those weren't the same.");
            } else {
                return first;
            }
        }
    }

    private hash(password: string): Promise<string> {
        return (this.options.hashPassword ?? ((p: string) => Bun.password.hash(p)))(password);
    }

    // ---- Email

    // An email address no other account has; null on Escape.
    private async askEmail(accountId = 0, note = '{white}For your code, and password resets.'): Promise<string | null> {
        for (;;) {
            const answer = await this.ask('Email:', { max: MAX_EMAIL, note });
            if (answer === null) {
                return null;
            }

            const email = answer.trim();
            if (!validEmail(email)) {
                await this.pause("{yellow}That doesn't look like an email address.");
            } else if (this.options.store.emailInUse(email, accountId)) {
                await this.pause('{yellow}That email address already has an account.');
            } else {
                return email;
            }
        }
    }

    // Has the player confirm their address (adding one if their account is
    // from before there were any); false if they leave it for now.
    private async confirmEmail(account: Account): Promise<boolean> {
        const { store } = this.options;
        let { email } = account;
        if (email === null) {
            email = await this.askEmail(account.id, '{yellow}Your account needs an email address now.');
            if (email === null) {
                return false;
            }

            store.setEmail(account.id, email);
        }

        // A code sent before (on an earlier visit) may still work.
        const sent = store.codeSentAt(account.id, 'confirm');
        const send = sent === null || this.now() - sent > CODE_MINUTES * 60_000;
        const confirmed = await this.typeCode(account, email, 'confirm', send);
        if (confirmed === null) {
            return false;
        }

        if (!store.confirmEmail(account.id)) {
            // Another account confirmed it while this one was waiting.
            await this.pause('{yellow}That email address already has an account.');
            return false;
        }

        this.options.log(`${account.name} confirmed their email address.`);
        return true;
    }

    // A new address for a playing account: their password, the address, and
    // the code sent to it. The old address is told.
    private async changeEmail(account: Account): Promise<void> {
        const { store, mailer, log } = this.options;
        const password = await this.ask('Password:', { mask: true, max: MAX_PASSWORD, note: '{white}To change your email address.' });
        if (password === null) {
            return;
        }

        if (!(await this.verify(password, account))) {
            await this.pause('{lightred}Wrong password.');
            return;
        }

        const old = store.account(account.name)?.email ?? null;
        const email = await this.askEmail(account.id, `{white}Now: ${escapeMarkup(old ?? 'none')}`);
        if (email === null) {
            return;
        }

        store.deleteCode(account.id, 'change');
        const confirmed = await this.typeCode(account, email, 'change', true);
        if (confirmed === null) {
            return;
        }

        if (!store.changeEmail(account.id, confirmed)) {
            await this.pause('{yellow}That email address already has an account.');
            return;
        }

        log(`${account.name} changed their email address.`);
        if (old !== null && old.toLowerCase() !== confirmed.toLowerCase()) {
            // Not one of the emails the player asked for, and not worth
            // stopping for if it can't be sent.
            mailer.send(changedEmail(old, account.name)).catch((error: unknown) => {
                log(`Couldn't email ${account.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }

        await this.pause('{lightgreen}Your email address is changed.');
    }

    // Has the player type the code sent to this address (sending it first,
    // if `send`); the address once they have (which they may have changed
    // on the way), or null if they leave it for now.
    private async typeCode(account: Account, address: string, purpose: 'confirm' | 'change', send: boolean): Promise<string | null> {
        const { store } = this.options;
        let email = address;
        let sendNow = send;
        for (;;) {
            if (!sendNow || (await this.sendCode(account, email, purpose))) {
                if (await this.enterCode(account.id, purpose, email)) {
                    return email;
                }
            }

            sendNow = false;
            const choice = await this.menu(['Type the code', 'Send a new code', 'Change email', 'Not now']);
            if (choice === 1) {
                sendNow = true;
            } else if (choice === 2) {
                const changed = await this.askEmail(account.id);
                if (changed !== null) {
                    email = changed;
                    if (purpose === 'confirm') {
                        store.setEmail(account.id, email);
                    } else {
                        store.deleteCode(account.id, 'change');
                    }
                    sendNow = true;
                }
            } else if (choice === 3) {
                return null;
            }
        }
    }

    private async resetPassword(): Promise<void> {
        const { store } = this.options;
        const name = await this.ask('Name:', { max: MAX_NAME, note: "{white}We'll email you a code." });
        if (name === null) {
            return;
        }

        const account = store.account(name.trim());
        if (!account?.emailConfirmed || account.email === null) {
            await this.pause('{yellow}There is no account by that name with a confirmed email.');
            return;
        }

        if (!(await this.sendCode(account, account.email, 'reset')) || !(await this.enterCode(account.id, 'reset', account.email))) {
            return;
        }

        const password = await this.askNewPassword(0);
        if (password === null) {
            return;
        }

        store.setPassword(account.id, await this.hash(password));
        this.options.log(`${account.name} reset their password.`);
        await this.pause('{lightgreen}Your password is changed. Log in with it now.');
    }

    // Emails a new code; false if it couldn't be. A code sent in the last
    // minute is used instead of sending another.
    private async sendCode(account: Account, email: string, purpose: CodePurpose): Promise<boolean> {
        const { store, mailer, log } = this.options;
        const now = this.now();
        const last = store.codeSentAt(account.id, purpose);
        if (last !== null && now - last < RESEND_WAIT) {
            await this.pause('{yellow}A code was sent a moment ago. Please use that one.');
            return true;
        }

        if (this.emailsSent >= (this.options.emailsPerVisit ?? MAX_EMAILS)) {
            await this.pause("{yellow}That's all the emails for this visit.");
            return false;
        }

        if (this.options.mayEmail?.(email) === false) {
            this.options.log(`Didn't email ${account.name}: too many emails from their address, or to that one.`);
            await this.pause('{yellow}Too many emails just now. Please try later.');
            return false;
        }

        this.emailsSent++;
        const code = String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, '0');
        this.notice('{white}Sending...');
        try {
            await mailer.send(codeEmail(email, account.name, purpose, code, CODE_MINUTES));
        } catch (error) {
            log(`Couldn't email ${account.name}: ${error instanceof Error ? error.message : String(error)}`);
            await this.pause("{lightred}The email couldn't be sent. Please try later.");
            return false;
        }

        store.saveCode(account.id, purpose, hashCode(code), now);
        return true;
    }

    // Asks for the code until it's right (true), or the player presses
    // Escape or the code runs out (false).
    private async enterCode(accountId: number, purpose: CodePurpose, email: string): Promise<boolean> {
        for (;;) {
            const typed = await this.ask('Code:', { note: `{white}We emailed a code to ${escapeMarkup(email)}.`, filter: (ch) => /^[0-9]$/.test(ch) });
            if (typed === null) {
                return false;
            }

            const result = this.options.store.checkCode(accountId, purpose, hashCode(typed), this.now());
            if (result === 'right') {
                return true;
            }

            if (result === 'none') {
                await this.pause('{yellow}That code has run out. Ask for a new one.');
                return false;
            }

            await this.pause("{yellow}That isn't the code.");
        }
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    // ---- Playing

    private async play(account: Account): Promise<void> {
        const { store, content, items } = this.options;
        if (!this.options.claim(account)) {
            await this.pause('{yellow}You are already in the realm somewhere else.');
            return;
        }

        try {
            store.noteLogin(account.id, this.options.address ?? null);
            this.options.log(`${account.name} enters the realm.`);
            const game = this.options.makeGame(account, (player) => {
                store.savePlayer(account.id, player);
            });
            this.playing = { account, game };

            const saved = store.loadPlayer(account.id);
            if (saved === null) {
                const player = game.freshPlayer();
                player.name = account.name;
                await game.begin(player);
            } else {
                const player = restorePlayer(content.start, saved, items, account.name);
                content.upgradeSave?.(saved, player);
                player.name = account.name;
                await game.resume(player);
            }

            // Escape from the map: carry on, change email, or leave.
            for (;;) {
                const choice = await this.menu(['Return to the game', 'Change email', 'Leave the realm']);
                if (choice === 1) {
                    await this.changeEmail(account);
                }

                // Too many wrong passwords, and the front door says goodbye.
                if (choice === 2 || this.wrongPasswords >= MAX_TRIES) {
                    break;
                }

                await game.resume(game.playing, { arrive: false });
            }
        } finally {
            this.save();
            this.options.log(`${account.name} leaves the realm.`);
            this.playing = null;
            this.options.release(account.id);
        }
    }

    // ---- The screen

    // The title screen with these options in its box. Escape picks the last.
    private async menu(options: readonly string[]): Promise<number> {
        this.titleScreen();
        const { color, selectedColor } = this.options.content.title.menu;
        const picked = await choose(this.term, options, { x: BOX.x, y: BOX.top + 1, colors: { normal: color, selected: selectedColor } });
        return picked < 0 ? options.length - 1 : picked;
    }

    // A question in the box; null if the player presses Escape. Questions
    // asked together go on different rows of the box. A note goes under it.
    private async ask(question: string, { mask = false, row = 0, max = BOX.width - 1, note = '', filter }: AskOptions = {}): Promise<string | null> {
        if (row === 0) {
            this.titleScreen();
        }

        if (note) {
            this.notice(note);
        }

        const y = BOX.top + 1 + row;
        draw(this.term.screen, `{white}${question}`, { x: BOX.x, y, bg: 1 });
        return askText(this.term, { x: BOX.x, y: y + 1, length: BOX.width, fg: 15, bg: 0, max, ...(mask ? { mask: '*' } : {}), ...(filter ? { filter } : {}) });
    }

    private async pause(text: string): Promise<void> {
        this.notice(text);
        await this.term.key();
    }

    // A line under the title screen's box.
    private notice(text: string): void {
        const { screen } = this.term;
        screen.fillRow(25, 0);
        draw(screen, `{center}${text}`, { y: 25, bg: 0, wrap: false });
        this.term.flush();
    }

    private titleScreen(): void {
        const { screen } = this.term;
        screen.clear();
        for (const line of this.options.content.title.art(this.options.config)) {
            draw(screen, line);
        }

        for (let y = BOX.top; y <= BOX.bottom; y++) {
            screen.text(BOX.x - 1, y, ' '.repeat(BOX.width + 1), 15, 1);
        }
    }
}
