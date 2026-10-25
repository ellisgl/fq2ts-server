// Sending email: the codes that confirm a player's address and reset their
// password. Through an SMTP server (nodemailer), or, with none set up, into
// the server's log (for trying the server out).

import { createTransport } from 'nodemailer';

export interface Email {
    to: string;
    subject: string;
    text: string;
}

export interface Mailer {
    send(email: Email): Promise<void>;
}

export interface SmtpOptions {
    host: string;
    // 465 is TLS from the start; anything else (587, 25) upgrades with STARTTLS.
    port: number;
    user?: string;
    password?: string;
    // Who the email comes from, as "Name <address>" or just the address.
    from: string;
}

export function smtpMailer({ host, port, user, password, from }: SmtpOptions): Mailer {
    const transport = createTransport({
        host,
        port,
        secure: port === 465,
        ...(user === undefined ? {} : { auth: { user, pass: password ?? '' } }),
    });
    return {
        send: async ({ to, subject, text }) => {
            await transport.sendMail({ from, to, subject, text });
        },
    };
}

// Writes emails to the log instead of sending them.
export function logMailer(log: (line: string) => void): Mailer {
    return {
        send: ({ to, subject, text }) => {
            log(`Email to ${to}: ${subject}\n${text}`);
            return Promise.resolve();
        },
    };
}

// Email addresses: something@something.something, with nothing that could
// be a space or markup, and no longer than addresses may be.
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`|~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const MAX_EMAIL = 254;

export function validEmail(email: string): boolean {
    return email.length <= MAX_EMAIL && EMAIL_PATTERN.test(email);
}

export type CodePurpose = 'confirm' | 'reset';

export const GAME_NAME = 'Final Quest 2';

// The email with a code in it.
export function codeEmail(to: string, name: string, purpose: CodePurpose, code: string, minutes: number): Email {
    const why = purpose === 'confirm'
        ? `This confirms the email address of ${name}'s account.`
        : `Someone (we hope you) asked to reset the password of ${name}'s account.`;
    return {
        to,
        subject: `${GAME_NAME}: your code is ${code}`,
        text: `${why}\n\nYour code is ${code}. Type it into the game; it works for ${minutes} minutes.\n\nIf you didn't ask for this, you can ignore this email.\n`,
    };
}
