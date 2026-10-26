// The game rules a server can change: how often players can fight each
// other and what's won, how much they can say and write, and how long
// things are kept. Each can be set on the command line or in .env (see
// RULE_OPTIONS); these are the defaults.

import { FIGHTS_PER_DAY, PVP_EXP_PERCENT, PVP_GOLD_PERCENT } from './pvp.ts';
import { CHAT_WAIT } from './realm.ts';
import { MAX_EMAILS } from './session.ts';
import { MAILBOX, NEWS_DAYS } from './store.ts';
import { LETTERS_PER_VISIT } from './talk.ts';
import { DEFAULT_GUARD, type GuardRules } from './guard.ts';

// (The guard's rules, on connections and wrong passwords, are among them.)
export interface Rules extends GuardRules {
    // Fights each player can start against others in a day.
    fightsPerDay: number;
    // How much of the loser's gold the winner of a fight between players
    // takes, and how much of their experience the winner gets, in percent.
    pvpGoldPercent: number;
    pvpExpPercent: number;
    // How long a player waits before saying (or yelling) something again.
    chatWaitSeconds: number;
    // Letters one visit can send, and how many a mailbox keeps.
    lettersPerVisit: number;
    mailbox: number;
    // How many days the news is kept.
    newsDays: number;
    // Emails (codes) one connection can ask for.
    emailsPerVisit: number;
}

export const DEFAULT_RULES: Rules = {
    fightsPerDay: FIGHTS_PER_DAY,
    pvpGoldPercent: PVP_GOLD_PERCENT,
    pvpExpPercent: PVP_EXP_PERCENT,
    chatWaitSeconds: CHAT_WAIT / 1000,
    lettersPerVisit: LETTERS_PER_VISIT,
    mailbox: MAILBOX,
    newsDays: NEWS_DAYS,
    emailsPerVisit: MAX_EMAILS,
    ...DEFAULT_GUARD,
};

// Each rule's command line option (--fights-per-day; FQ2_FIGHTS_PER_DAY in
// .env), what it's for, and the least (and most) it can be.
interface RuleOption {
    rule: keyof Rules;
    option: string;
    help: string;
    min: number;
    max?: number;
}

export const RULE_OPTIONS = [
    { rule: 'fightsPerDay', option: 'fights-per-day', help: 'fights each player can start against others a day', min: 0 },
    { rule: 'pvpGoldPercent', option: 'pvp-gold-percent', help: "of the loser's gold the winner takes", min: 0, max: 100 },
    { rule: 'pvpExpPercent', option: 'pvp-exp-percent', help: "of the loser's experience the winner gets", min: 0, max: 100 },
    { rule: 'chatWaitSeconds', option: 'chat-wait-seconds', help: 'how long before a player can talk again', min: 0 },
    { rule: 'lettersPerVisit', option: 'letters-per-visit', help: 'letters a player can send each visit', min: 0 },
    { rule: 'mailbox', option: 'mailbox', help: 'letters kept for each player (the oldest go)', min: 1 },
    { rule: 'newsDays', option: 'news-days', help: 'days the news is kept', min: 1 },
    { rule: 'emailsPerVisit', option: 'emails-per-visit', help: 'emails (codes) a connection can ask for', min: 1 },
    { rule: 'connectionsPerMinute', option: 'connections-per-minute', help: 'connections an address can make a minute', min: 1 },
    { rule: 'loginFailuresPerAddress', option: 'login-failures-per-address', help: 'wrong passwords from an address before logins from it stop', min: 1 },
    { rule: 'loginFailuresPerAccount', option: 'login-failures-per-account', help: 'wrong passwords for an account before logins to it stop', min: 1 },
    { rule: 'lockoutMinutes', option: 'lockout-minutes', help: '...for how long', min: 1 },
] as const satisfies readonly RuleOption[];
