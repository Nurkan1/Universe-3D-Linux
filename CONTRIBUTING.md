# Contributing

Thanks for taking the time to contribute.

## Getting set up

Install the system dependencies listed in the [README](README.md#requirements),
then:

```bash
npm install
npm run dev
```

## Before opening a pull request

CI runs the following and fails the build on any of them, so please run them
locally first:

```bash
cd src-tauri
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
```

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `chore:`, `docs:`). Explain *why* in the body, not just what.
- **Code and comments are written in English.**
- Comments should explain reasoning that is not obvious from the code. Skip the
  ones that restate it.
- Match the style of the surrounding code rather than introducing a new one.

## Reporting bugs

Please include your distribution and desktop environment, the output of
`universe-3d` run from a terminal, and the steps to reproduce.

Because the app enumerates every `.desktop` entry on the system, bugs often
depend on a specific entry — if you can identify which application triggers it,
attaching that `.desktop` file helps enormously.

## Security

Do not report security issues in a public issue. See [SECURITY.md](SECURITY.md).
