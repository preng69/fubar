# Project Instructions

## Repository Shape

- `dtf-protocol.txt` is the draft DTF protocol specification.
- `tsnode/` is the root of the client-side TypeScript package.
- Run package commands from `tsnode/`, not from the repository root.

## Client Package

- The package in `tsnode/` is a browser/Vite-friendly mock DTF client.
- Keep runtime behavior deterministic at this layer.
- Do not simulate UDP transport behavior here, including latency, packet loss, out-of-order delivery, retries, or transport failures.
- Mock data for simple UI testing lives in `tsnode/src/mock-data.ts`.

## Generated Files

- Do not commit `node_modules/` or `dist/`.
- Local dependencies and build output belong under `tsnode/` when working on the client package.

## Validation

From `tsnode/`, use:

```sh
npm run build
npm run typecheck
npm run smoke
```
