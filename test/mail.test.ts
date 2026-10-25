import { describe, expect, test } from 'bun:test';
import { codeEmail, logMailer, smtpMailer, validEmail } from '../../server/mail.ts';
import { caught } from '../helpers.ts';

test.each([
    ['hero@example.com', true],
    ['first.last+fq2@mail.example.co.uk', true],
    ['no-at-sign.example.com', false],
    ['two@@example.com', false],
    ['hero@localhost', false],
    ['spa ce@example.com', false],
    ['{red}@example.com', false],
    ['hero@example.com\r\nBcc: x@example.com', false],
    [`${'a'.repeat(250)}@example.com`, false],
])('validEmail(%p) is %p', (email, valid) => {
    expect(validEmail(email)).toBe(valid);
});

describe('codeEmail', () => {
    test('says what the code is for, and for how long', () => {
        const confirm = codeEmail('h@example.com', 'Hero', 'confirm', '012345', 15);
        expect(confirm.subject).toBe('Final Quest 2: your code is 012345');
        expect(confirm.text).toContain("confirms the email address of Hero's account");
        expect(confirm.text).toContain('Your code is 012345. Type it into the game; it works for 15 minutes.');
        expect(codeEmail('h@example.com', 'Hero', 'reset', '1', 15).text).toContain("reset the password of Hero's account");
    });
});

test('logMailer writes emails to the log', async () => {
    const logs: string[] = [];
    await logMailer((line) => logs.push(line)).send({ to: 'h@example.com', subject: 'Hi', text: 'There' });
    expect(logs).toEqual(['Email to h@example.com: Hi\nThere']);
});

// Just enough of an SMTP server to take one email, with a login.
function fakeSmtp(): { port: number; said: string[]; stop(): void } {
    const said: string[] = [];
    let inData = false;
    const server = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
            open: (socket) => {
                socket.write('220 fake ESMTP\r\n');
            },
            data: (socket, data) => {
                for (const line of new TextDecoder().decode(data).split('\r\n').filter((l, i, all) => l !== '' || i < all.length - 1)) {
                    said.push(line);
                    if (inData) {
                        if (line === '.') {
                            inData = false;
                            socket.write('250 OK\r\n');
                        }
                    } else if (/^EHLO/i.test(line)) {
                        socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
                    } else if (/^AUTH PLAIN/i.test(line)) {
                        socket.write('235 OK\r\n');
                    } else if (/^DATA/i.test(line)) {
                        inData = true;
                        socket.write('354 Go on\r\n');
                    } else if (/^QUIT/i.test(line)) {
                        socket.write('221 Bye\r\n');
                        socket.end();
                    } else {
                        socket.write('250 OK\r\n');
                    }
                }
            },
        },
    });
    return {
        port: server.port,
        said,
        stop: () => {
            server.stop(true);
        },
    };
}

test('smtpMailer sends through an SMTP server, logging in', async () => {
    const smtp = fakeSmtp();
    try {
        await smtpMailer({ host: '127.0.0.1', port: smtp.port, user: 'game', password: 'pw', from: 'Final Quest 2 <game@example.com>' })
            .send({ to: 'hero@example.com', subject: 'Your code', text: 'It is 123456.' });
        const all = smtp.said.join('\n');
        expect(all).toContain(`AUTH PLAIN ${btoa('\0game\0pw')}`);
        expect(all).toContain('MAIL FROM:<game@example.com>');
        expect(all).toContain('RCPT TO:<hero@example.com>');
        expect(all).toContain('Subject: Your code');
        expect(all).toContain('It is 123456.');
    } finally {
        smtp.stop();
    }
});

test("smtpMailer fails when the server won't take the email", async () => {
    const smtp = fakeSmtp();
    smtp.stop();
    const mailer = smtpMailer({ host: '127.0.0.1', port: smtp.port, from: 'game@example.com' });
    expect(await caught(mailer.send({ to: 'hero@example.com', subject: 'S', text: 'T' }))).toBeInstanceOf(Error);
});
