import { describe, expect, test } from 'bun:test';
import { Guard, isLocal, normalAddress, webAddress } from '../src/guard.ts';

const MINUTE = 60_000;

describe('addresses', () => {
    test('an IPv4 address that came as IPv6 is the IPv4 address', () => {
        expect(normalAddress('::ffff:203.0.113.9')).toBe('203.0.113.9');
        expect(normalAddress(' 2001:DB8::1 ')).toBe('2001:db8::1');
        expect(normalAddress('::ffff:0:1')).toBe('::ffff:0:1');
    });

    test('this machine', () => {
        expect(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'].map(isLocal)).toEqual([true, true, true, true]);
        expect(isLocal('203.0.113.9')).toBe(false);
    });

    test("a web player's: X-Forwarded-For only behind a proxy we trust, and the address it added", () => {
        expect(webAddress('127.0.0.1', '198.51.100.7', false)).toBe('127.0.0.1');
        expect(webAddress('127.0.0.1', '198.51.100.7', true)).toBe('198.51.100.7');
        // A client can send its own X-Forwarded-For; the proxy adds the real
        // address at the end.
        expect(webAddress('127.0.0.1', '6.6.6.6, 198.51.100.7', true)).toBe('198.51.100.7');
        expect(webAddress('::ffff:127.0.0.1', null, true)).toBe('127.0.0.1');
        expect(webAddress(null, null, false)).toBe('unknown');
    });
});

describe('Guard', () => {
    function guard(rules = {}) {
        let now = 0;
        const g = new Guard({ rules: { connectionsPerMinute: 3, loginFailuresPerAddress: 3, loginFailuresPerAccount: 5, lockoutMinutes: 10, ...rules }, now: () => now });
        return { g, later: (ms: number) => (now += ms) };
    }

    test('an address can make so many connections a minute', () => {
        const { g, later } = guard();
        expect([g.connect('a'), g.connect('a'), g.connect('a'), g.connect('a')]).toEqual([true, true, true, false]);
        expect(g.connect('b')).toBe(true);
        later(MINUTE);
        expect(g.connect('a')).toBe(true);
    });

    test('too many wrong passwords from an address shut logins from it, for a while', () => {
        const { g, later } = guard();
        for (const name of ['ann', 'bob', 'cat']) {
            expect(g.loginShut('a', name)).toBeNull();
            g.failed('a', name);
        }
        expect(g.loginShut('a', 'dan')).toBe('Too many wrong passwords from your address. Try again in 10 minutes.');
        expect(g.loginShut('b', 'dan')).toBeNull();
        later(10 * MINUTE);
        expect(g.loginShut('a', 'dan')).toBeNull();
    });

    test('too many wrong passwords for an account, from anywhere, shut logins to it', () => {
        const { g } = guard();
        for (const address of ['a', 'b', 'c', 'd', 'e']) {
            g.failed(address, 'Ann');
        }
        expect(g.loginShut('f', 'ANN')).toBe('Too many wrong passwords for this account. Try again in 10 minutes.');
        expect(g.loginShut('f', 'bob')).toBeNull();
    });

    test("what's old is let go, so nothing piles up", () => {
        const { g, later } = guard();
        for (let i = 0; i < 100; i++) {
            g.connect(`10.0.0.${i}`);
            g.failed(`10.0.0.${i}`, `player${i}`);
        }
        expect(g.size).toBe(300);
        later(10 * MINUTE);
        g.prune();
        expect(g.size).toBe(0);
    });
});
