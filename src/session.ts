// One player's connection to the server: the login screen, then the game,
// until they leave or the connection goes.

import { draw } from '../engine/text.ts';
import { askText, choose } from '../engine/ui.ts';
import { Disconnected, type Terminal } from '../engine/terminal.ts';
import { restorePlayer, type FlagRecord, type Player } from '../engine/player.ts';
import type { ItemCatalogue } from '../engine/items.ts';
import type { Config, Content, Game } from '../engine/game.ts';
import { validName, type Account, type Store } from './store.ts';

// Wrong passwords before the connection is closed.
const MAX_TRIES = 3;
export const MIN_PASSWORD = 6;

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
    hashPassword?(password: string): Promise<string>;
    verifyPassword?(password: string, hash: string): Promise<boolean>;
}

// The login box sits in the title screen's menu box.
const BOX = { x: 33, top: 16, width: 17, bottom: 23 };

export class Session<F extends FlagRecord> {
    private readonly options: SessionOptions<F>;
    private readonly term: Terminal;
    // The player being played, to save if the connection goes.
    private playing: { account: Account; game: Game<F> } | null = null;
    private wrongPasswords = 0;

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
            const choice = await this.menu(['Log in', 'New player', 'Leave this place']);
            let account: Account | null = null;
            if (choice === 0) {
                account = await this.logIn();
            } else if (choice === 1) {
                account = await this.signUp();
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

        return account;
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

        let password: string | null = null;
        while (password === null) {
            const first = await this.ask('Password:', { mask: true, row: 2 });
            if (first === null) {
                return null;
            }

            const again = await this.ask('Once more:', { mask: true, row: 4 });
            if (again === null) {
                return null;
            }

            if (first.length < MIN_PASSWORD) {
                await this.pause(`{yellow}At least ${MIN_PASSWORD} characters, please.`);
            } else if (first !== again) {
                await this.pause("{yellow}Those weren't the same.");
            } else {
                password = first;
            }
        }

        const hash = await (this.options.hashPassword ?? ((p: string) => Bun.password.hash(p)))(password);
        const account = store.createAccount(name, hash);
        if (!account) {
            // Someone took the name while this player was typing.
            await this.pause('{yellow}Someone just took that name. Try another.');
            return null;
        }

        this.options.log(`New account: ${account.name}`);
        return account;
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
    // asked together go on different rows of the box.
    private async ask(question: string, { mask = false, row = 0 } = {}): Promise<string | null> {
        if (row === 0) {
            this.titleScreen();
        }

        const y = BOX.top + 1 + row;
        draw(this.term.screen, `{white}${question}`, { x: BOX.x, y, bg: 1 });
        return askText(this.term, { x: BOX.x, y: y + 1, length: BOX.width, fg: 15, bg: 0, ...(mask ? { mask: '*' } : {}) });
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
