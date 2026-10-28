# @fq2ts/server

Multiplayer for `@fq2ts/engine` games, played in a web browser (xterm.js),
with accounts with
confirmed email addresses and password resets, and players saved in SQLite. A game runs it with its content:

```ts
import { runServer } from '@fq2ts/server/cli';
runServer({ content, name: 'My Game', gameData: 'path/to/data' });
```

`-h` lists the options; each can also be set in the environment or a `.env`
file.

## Using it

```sh
bun add @fq2ts/server@github:ellisgl/fq2ts-server#v0.1.0
```

It ships its TypeScript source, which Bun runs as it is.

It needs `@fq2ts/engine` too, named by commit hash in the game's
`dependencies` and `overrides` (see the engine's README).

## Development

```sh
bun install
bun run check          # tsc (strict) + eslint + tests
```
