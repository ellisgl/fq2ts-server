// Keeping the door: how many connections an address can make in a minute,
// and how many wrong passwords an address, or an account, can have before
// logging in is shut for a while. This is what stops guessing passwords by
// reconnecting (three wrong ones close a connection, but a new one is easy
// to make). Everything is kept in memory and let go when it's old.

// An address as it's kept and banned: an IPv4 address that came as IPv6
// ("::ffff:1.2.3.4") is the IPv4 address; letters are lower case.
export function normalAddress(address: string): string {
    const lower = address.trim().toLowerCase();
    return lower.startsWith('::ffff:') && lower.includes('.') ? lower.slice('::ffff:'.length) : lower;
}

// Whether an address is this machine (everyone behind a proxy looks like it).
export function isLocal(address: string): boolean {
    const a = normalAddress(address);
    return a === '::1' || a.startsWith('127.') || a === 'localhost';
}

// The player's address on the web: the server's view of it, or (behind a
// proxy we trust) the last address the proxy added to X-Forwarded-For.
export function webAddress(direct: string | null, forwardedFor: string | null, trustProxy: boolean): string {
    if (trustProxy && forwardedFor) {
        const added = forwardedFor.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
        if (added) {
            return normalAddress(added);
        }
    }
    return normalAddress(direct ?? 'unknown');
}

export interface GuardRules {
    // Connections an address can make in a minute.
    connectionsPerMinute: number;
    // Wrong passwords before logging in is shut, from one address and for
    // one account, over `lockoutMinutes` (and for that long after).
    loginFailuresPerAddress: number;
    loginFailuresPerAccount: number;
    lockoutMinutes: number;
}

export const DEFAULT_GUARD: GuardRules = { connectionsPerMinute: 20, loginFailuresPerAddress: 10, loginFailuresPerAccount: 20, lockoutMinutes: 15 };

export class Guard {
    private readonly rules: GuardRules;
    private readonly now: () => number;
    // The times of recent connections, and of wrong passwords, by address
    // or account name (lower case).
    private readonly connections = new Map<string, number[]>();
    private readonly addressFailures = new Map<string, number[]>();
    private readonly accountFailures = new Map<string, number[]>();

    public constructor({ rules = DEFAULT_GUARD, now = Date.now }: { rules?: GuardRules; now?(): number } = {}) {
        this.rules = rules;
        this.now = now;
    }

    // A new connection from this address: whether it may come in (if so,
    // it's counted).
    public connect(address: string): boolean {
        const recent = this.recent(this.connections, address, 60_000);
        if (recent.length >= this.rules.connectionsPerMinute) {
            return false;
        }
        recent.push(this.now());
        return true;
    }

    // Why logging in is shut for this address or account, or null if it
    // isn't.
    public loginShut(address: string, name: string): string | null {
        const window = this.rules.lockoutMinutes * 60_000;
        if (this.recent(this.addressFailures, address, window).length >= this.rules.loginFailuresPerAddress) {
            return `Too many wrong passwords from your address. Try again in ${this.rules.lockoutMinutes} minutes.`;
        }
        if (this.recent(this.accountFailures, name.toLowerCase(), window).length >= this.rules.loginFailuresPerAccount) {
            return `Too many wrong passwords for this account. Try again in ${this.rules.lockoutMinutes} minutes.`;
        }
        return null;
    }

    // A wrong name or password, from this address, for this account name.
    public failed(address: string, name: string): void {
        const window = this.rules.lockoutMinutes * 60_000;
        this.recent(this.addressFailures, address, window).push(this.now());
        this.recent(this.accountFailures, name.toLowerCase(), window).push(this.now());
    }

    // Lets go of what's too old to count (called now and then).
    public prune(): void {
        const window = this.rules.lockoutMinutes * 60_000;
        for (const [times, age] of [[this.connections, 60_000], [this.addressFailures, window], [this.accountFailures, window]] as const) {
            for (const key of [...times.keys()]) {
                if (!this.recent(times, key, age).length) {
                    times.delete(key);
                }
            }
        }
    }

    // How many things are being kept (for tests: they don't pile up).
    public get size(): number {
        return this.connections.size + this.addressFailures.size + this.accountFailures.size;
    }

    // The times under `key` within the last `age` milliseconds (older ones
    // are dropped).
    private recent(times: Map<string, number[]>, key: string, age: number): number[] {
        const cutoff = this.now() - age;
        const kept = (times.get(key) ?? []).filter((t) => t > cutoff);
        times.set(key, kept);
        return kept;
    }
}
