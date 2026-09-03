# Security policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch.
Older plugin versions might not receive separate patches.

## Reporting a vulnerability

Email [security@fly.io](mailto:security@fly.io) with `openclaw-sprites` in the
subject. Report vulnerabilities privately rather than through public issues
or pull requests.

Include affected versions, reproduction steps, expected impact, and whether
the issue concerns sandbox isolation, token handling, workspace transfer,
runtime ownership, or the Sprites API. Use fake tokens and redacted examples;
do not send active credentials or private workspace data.

Fly.io's security contact is also documented in the
[Fly.io security documentation](https://fly.io/docs/security/#talk-to-the-security-team).

## Scope

This plugin connects an OpenClaw Gateway to remote Sprites. Commands and file
tools run inside Sprites, while the Gateway retains the API credentials and
controls workspace uploads. Vulnerabilities in the plugin or Sprites can be
reported through the Fly.io channel above. Vulnerabilities in OpenClaw itself
should also be reported through OpenClaw's security process.
