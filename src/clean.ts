// Clean mode (LORD II's "swear patrol"): swear words in what players say
// and write are starred out, and a new player can't be called one. A
// server can give its own list of words, or turn it off with an empty one.
//
// Each entry is a word, matched whole and in any case: "ass" stars out
// "ass" but not "class". A * at its start or end lets the word go on that
// way: "fuck*" catches "fucking", "*shit*" catches "bullshit". Numbers
// and signs that stand for letters count as them ("sh1t", "@ss").

// The list used unless a server gives its own.
export const DEFAULT_BAD_WORDS: readonly string[] = [
    '*fuck*', '*shit*', 'cunt*', 'bitch*', 'bastard*', '*asshole*', 'ass', 'asses', 'arse', 'arsehole*',
    'dick', 'dicks', 'dickhead*', 'cock', 'cocks', 'cocksucker*', 'piss*', 'wank*', 'twat*', 'slut*', 'whore*',
    'prick', 'pricks', 'bollocks', 'tits', 'titties', 'pussy', 'pussies', 'jizz*', 'cum', 'dildo*',
    'fag', 'fags', 'faggot*', 'nigger*', 'nigga*', 'retard', 'retards', 'retarded', 'spic', 'spics',
    'chink', 'chinks', 'kike', 'kikes', 'tranny', 'trannies', 'coon', 'coons', 'wetback*',
];

// Reads a list of words from a file's text: one a line, # for comments.
export function readBadWords(text: string): string[] {
    return text.split('\n').map((line) => line.replace(/#.*/, '').trim().toLowerCase()).filter((line) => line !== '');
}

// What letters numbers and signs stand for.
const LOOKALIKES: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };
// A word, as it's checked: letters, and what might stand for them (a !
// only inside a word, not ending a sentence).
const WORD = /[\p{L}\p{N}@$]+(?:!+[\p{L}\p{N}@$]+)*/gu;

export class Clean {
    private readonly whole = new Set<string>();
    private readonly patterns: RegExp[] = [];

    public constructor(words: readonly string[] = DEFAULT_BAD_WORDS) {
        for (const entry of words) {
            const word = entry.toLowerCase().replace(/^\*|\*$/g, '');
            if (word === '') {
                continue;
            }
            if (word === entry.toLowerCase()) {
                this.whole.add(word);
            } else {
                const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                this.patterns.push(new RegExp(`${entry.startsWith('*') ? '' : '^'}${escaped}${entry.endsWith('*') ? '' : '$'}`, 'u'));
            }
        }
    }

    // `text` with each bad word starred out.
    public text(text: string): string {
        return text.replace(WORD, (word) => (this.isBad(word) ? '*'.repeat([...word].length) : word));
    }

    // Whether `text` has no bad words in it.
    public allows(text: string): boolean {
        return [...text.matchAll(WORD)].every(([word]) => !this.isBad(word));
    }

    private isBad(word: string): boolean {
        const lower = word.toLowerCase();
        // (Checked as typed, and with the look-alikes as letters: "5" is
        // only an s in a word with letters in it.)
        const forms = /\p{L}/u.test(lower) ? [lower, [...lower].map((ch) => LOOKALIKES[ch] ?? ch).join('')] : [lower];
        return forms.some((form) => this.whole.has(form) || this.patterns.some((pattern) => pattern.test(form)));
    }
}
