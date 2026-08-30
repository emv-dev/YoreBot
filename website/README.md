# YoreBot website

One-route customer site for YoreBot. It is isolated from the desktop app build.

## Validate

```bash
npm ci
npm test
npm run lint
```

## Signed Windows download

The site intentionally renders no download link by default. A release build may
set `YOREBOT_SIGNED_RELEASE_URL` to the complete HTTPS URL of a signed `.exe`
installer under
`https://github.com/emv-dev/YoreBot/releases/download/<tag>/YoreBot*.exe`.
The value is used unchanged; alternate hosts, ports, query strings, fragments,
credentials, and invalid paths fail closed.

## Hosting

Sites project metadata lives in `.openai/hosting.json`. Do not add secrets or
deployment credentials to that file.
