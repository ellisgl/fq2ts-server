# @fq2ts/server

Multiplayer for `@fq2ts/engine` games: SSH and the web (xterm.js in the
browser; no telnet, which would send passwords in the clear), accounts with
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

ssh2 1.17.0 has to be patched not to load its optional native add-ons, which
crash Bun. Bun reads this package's `patchedDependencies` but looks for the
patch in the game's folder, so without it the install fails. A game that
runs the server copies [patches/ssh2@1.17.0.patch](patches/ssh2@1.17.0.patch)
into its own `patches/` folder and adds to its `package.json`:

```json
"patchedDependencies": { "ssh2@1.17.0": "patches/ssh2@1.17.0.patch" }
```

## Development

```sh
bun install
bun run check          # tsc (strict) + eslint + tests
```
