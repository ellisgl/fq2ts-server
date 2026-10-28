import { describe, expect, test } from 'bun:test';
import { Clean, DEFAULT_BAD_WORDS, readBadWords } from '../src/clean.ts';

describe('clean mode', () => {
    const clean = new Clean();

    test('stars out swear words in any case, keeping their length', () => {
        expect(clean.text('Well, SHIT.')).toBe('Well, ****.');
        expect(clean.text('what an asshole')).toBe('what an *******');
    });

    test('whole words only, unless the entry goes on with *', () => {
        expect(clean.text('a class assassin passes the ass')).toBe('a class assassin passes the ***');
        expect(clean.text('fucking bullshit')).toBe('******* ********');
        expect(clean.text('Scunthorpe is a cocktail of cockatrice')).toBe('Scunthorpe is a cocktail of cockatrice');
    });

    test('numbers and signs that stand for letters count as them', () => {
        expect(clean.text('sh1t @ss b!tch f4g')).toBe('**** *** ***** ***');
        // (Numbers on their own are only numbers, and ! still ends a sentence.)
        expect(clean.text('I have 455 gold! Ass!')).toBe('I have 455 gold! ***!');
    });

    test('allows checks names', () => {
        expect(clean.allows('Sir Galahad')).toBe(true);
        expect(clean.allows('Sir Sh1thead')).toBe(false);
        expect(clean.allows('Dick')).toBe(false);
    });

    test("a server's own list, read from a file; an empty one lets everything through", () => {
        const words = readBadWords('# Our words\nDarn\nheck*  # and hecking\n\n');
        expect(words).toEqual(['darn', 'heck*']);
        const own = new Clean(words);
        expect(own.text('darn it, hecking shit')).toBe('**** it, ******* shit');
        expect(new Clean([]).text('fuck')).toBe('fuck');
        expect(DEFAULT_BAD_WORDS.length).toBeGreaterThan(10);
    });
});
