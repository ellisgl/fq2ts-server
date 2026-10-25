// One player's connection to the server: the login screen, then the game,
// until they leave or the connection goes.
//
// Every account has an email address, confirmed with a code sent to it
// before the account can play; a forgotten password is reset with another
// code.

import { draw, escapeMarkup } from '../engine/text.ts';
import { askText, choose } from '../engine/ui.ts';
import { Disconnected, type Terminal } from '../engine/terminal.ts';
import { restorePlayer, type FlagRecord, type Player } from '../engine/player.ts';
import type { ItemCatalogue } from '../engine/items.ts';
import type { Config, Content, Game } from '../engine/game.ts';
import { codeEmail, MAX_EMAIL, validEmail, type CodePurpose, type Mailer } from './mail.ts';
import { CODE_MINUTES, validName, type Account, type Store } from './store.ts';

// Wrong passwords before the connection is closed.
const MAX_TRIES = 3;
export const MIN_PASSWORD = 6;
// How soon another code can be sent for the same thing.
export const RESEND_WAIT = 60_000;
// Emails one connection can ask for (so it can't be used to send lots).
export const MAX_EMAILS = 5;
const CODE_LENGTH = 6;

export interface SessionOptions<F extends FlagRecord> {
    term: Terminal;
    store: Store;
    content: Content<F>;
    items: ItemCatalogue;
    config: Config;
    // Makes this connection's game, which saves the player through `autosave`.
    makeGame(autosave: (player: Player<F>) => void): Game<F>;
    // Marks an account as playing; false if it already is (elsewhere).
    claim(accountId: number): boolean;
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

export class Session<F extends FlagRecord> {
    private readonly options: SessionOptions<F>;
    private readonly term: Terminal;
    // The player being played, to save if the connection goes.
    private playing: { account: Account; game: Game<F> } | null = null;
    private wrongPasswords = 0;
    private emailsSent = 0;

    public constructor(options: SessionOptions<F>) {
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
        if (this.playing) {
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
        const name = await this.ask('Name:');
        if (name === null) {
            return null;
        }

        const password = await this.ask('Password:', { mask: true, row: 2 });
        if (password === null) {
            return null;
        }

        const account = this.options.store.account(name.trim());
        const verify = this.options.verifyPassword ?? ((p: string, h: string) => Bun.password.verify(p, h));
        if (!account || !(await verify(password, account.passwordHash))) {
            this.wrongPasswords++;
            await this.pause('{lightred}Wrong name or password.');
            return null;
        }

        return account.emailConfirmed || (await this.confirmEmail(account)) ? account : null;
    }

    private async signUp(): Promise<Account | null> {
        const { store } = this.options;
        let name: string | null = null;
        while (name === null) {
            const answer = await this.ask('Your name:');
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

        this.options.log(`New account: ${account.name}`);
        return (await this.confirmEmail(account)) ? account : null;
    }

    // A new password, typed twice; null on Escape.
    private async askNewPassword(row: number): Promise<string | null> {
        for (;;) {
            const first = await this.ask('Password:', { mask: true, row });
            if (first === null) {
                return null;
            }

            const again = await this.ask('Once more:', { mask: true, row: row + 2 });
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

    // An email address; null on Escape.
    private async askEmail(note = '{white}For your code, and password resets.'): Promise<string | null> {
        for (;;) {
            const answer = await this.ask('Email:', { max: MAX_EMAIL, note });
            if (answer === null) {
                return null;
            }

            const email = answer.trim();
            if (validEmail(email)) {
                return email;
            }

            await this.pause("{yellow}That doesn't look like an email address.");
        }
    }

    // Has the player type the code sent to their address (sending one if
    // need be); false if they leave it for now. They can ask for another,
    // or change the address.
    private async confirmEmail(account: Account): Promise<boolean> {
        const { store } = this.options;
        let { email } = account;
        if (email === null) {
            // An account from before there were email addresses.
            email = await this.askEmail('{yellow}Your account needs an email address now.');
            if (email === null) {
                return false;
            }

            store.setEmail(account.id, email);
        }

        // A code sent before (on an earlier visit) may still work.
        const sent = store.codeSentAt(account.id, 'confirm');
        let send = sent === null || this.now() - sent > CODE_MINUTES * 60_000;
        for (;;) {
            if (!send || (await this.sendCode(account, email, 'confirm'))) {
                if (await this.enterCode(account.id, 'confirm', email)) {
                    store.confirmEmail(account.id);
                    this.options.log(`${account.name} confirmed their email address.`);
                    return true;
                }
            }

            send = false;
            const choice = await this.menu(['Type the code', 'Send a new code', 'Change email', 'Not now']);
            if (choice === 1) {
                send = true;
            } else if (choice === 2) {
                const changed = await this.askEmail();
                if (changed !== null) {
                    email = changed;
                    store.setEmail(account.id, email);
                    send = true;
                }
            } else if (choice === 3) {
                return false;
            }
        }
    }

    private async resetPassword(): Promise<void> {
        const { store } = this.options;
        const name = await this.ask('Name:', { note: "{white}We'll email you a code." });
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

        if (this.emailsSent >= MAX_EMAILS) {
            await this.pause("{yellow}That's all the emails for this visit.");
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
        if (!this.options.claim(account.id)) {
            await this.pause('{yellow}You are already in the realm somewhere else.');
            return;
        }

        try {
            store.noteLogin(account.id);
            this.options.log(`${account.name} enters the realm.`);
            const game = this.options.makeGame((player) => {
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

            // Escape from the map: carry on, or leave.
            while ((await this.menu(['Return to the game', 'Leave the realm'])) === 0) {
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
