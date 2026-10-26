# @fq2js/server

Multiplayer for `@fq2js/engine` games: SSH and the web (xterm.js in the
browser; no telnet, which would send passwords in the clear), accounts with
confirmed email addresses and password resets, and players saved in SQLite. A game runs it with its content:

```ts
import { runServer } from '@fq2js/server/cli';
runServer({ content, name: 'My Game', gameData: 'path/to/data' });
```

`-h` lists the options; each can also be set in the environment or a `.env`
file.
