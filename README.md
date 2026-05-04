# gold-ts

Minimal TypeScript full-stack framework that auto-generates a type-safe client from your backend API files at startup.

Zero build step, zero decorators, zero codegen CLI. Define functions — get a client.

## Installation

```sh
npm install github:dotmonk/gold-ts#<version>
```

> Requires [`tsx`](https://github.com/privatenumber/tsx) to run TypeScript directly (including from `node_modules`).

## Quick Start

### 1. Backend entry point — `backend/index.ts`

```ts
import express from 'express';
import gild from 'gold-ts';

const app = express();
gild(app, { dev: true });
```

Run with:

```sh
npx tsx watch backend/index.ts
```

### 2. Define an API — `backend/api/usersApi.ts`

Any `*Api.ts` file under `backend/` is picked up automatically. Export regular async functions or async generator functions.

```ts
interface User { name: string; age: number; }

const users: User[] = [];

// Regular function → becomes a POST request method on the client
export async function createUser(user: User): Promise<User> {
  users.push(user);
  return user;
}

// Async generator → becomes a streaming SSE subscription on the client
export async function* listUsers(): AsyncGenerator<User[]> {
  yield users;
  // keep connection open and push updates…
}
```

### 3. Use the generated client — `frontend/SomeComponent.tsx`

On startup, `gild` writes `frontend/client.ts` with fully typed methods. No manual step needed.

```ts
import { Users } from './client';

// One-shot request
const user = await Users.createUser({ name: 'Alice', age: 30 });

// SSE subscription — returns a stop function
const stop = Users.listUsers((users) => console.log(users));
// later…
stop();
```

## File uploads

Parameters typed as `UploadedFile` are automatically handled as multipart form fields. Pass a `File | Blob` from the browser.

```ts
// backend
import { type UploadedFile } from 'gold-ts';

export async function uploadAvatar(file: UploadedFile): Promise<void> {
  const buffer = await file.readAsBuffer();
  // save buffer…
}
```

```ts
// frontend (generated client accepts File | Blob)
await Profile.uploadAvatar(fileInput.files[0]);
```

### `UploadedFile` interface

| Property | Type | Description |
|---|---|---|
| `fieldName` | `string` | Form field name |
| `filename` | `string` | Original filename |
| `contentType` | `string` | MIME type |
| `size` | `number` | Bytes written |
| `tempFilePath` | `string` | Path to temp file |
| `createReadStream()` | `() => ReadStream` | Stream the file |
| `readAsBuffer()` | `() => Promise<Buffer>` | Read entire file into memory |

## API — `gild(app, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | Port to listen on |
| `dev` | `boolean` | `false` | Enable Vite HMR middleware and file watcher |
| `generatedClientPath` | `string` | `frontend/client.ts` | Where to write the generated client |
| `frontendDir` | `string` | `static/` | Static files directory (production) |
| `maxMultipartBytes` | `number` | 8 GB | Max total multipart request size |
| `maxMultipartFieldBytes` | `number` | 1 MB | Max size of a single non-file field |
| `multipartTmpDir` | `string` | OS temp dir | Directory for uploaded temp files |

## How it works

1. On startup, `gild` scans `backend/**/*Api.ts` with [ts-morph](https://ts-morph.com/) to extract function signatures, parameter types, and return types.
2. For each exported function it registers either a `POST /gold_request` handler (regular functions) or a `POST /gold_sse` handler (async generators).
3. A TypeScript client (`frontend/client.ts`) is generated with matching method signatures, interface definitions, and SSE subscription helpers.
4. In `dev` mode, Vite middleware is mounted for HMR. In production, the `frontendDir` is served as static files.

## Consumer project example layout

```
your-app/
├── backend/
│   ├── index.ts          ← entry point
│   └── api/
│       └── usersApi.ts   ← any *Api.ts file here is picked up
├── frontend/
│   ├── client.ts         ← auto-generated, do not edit
│   └── index.tsx
├── static/               ← production build output
├── tsconfig.json
└── package.json
```

## This repository layout

```
gold-ts/
├── src/
│   └── index.ts          ← package source
├── package.json
└── README.md
```

## Example app

The [`example`](https://github.com/dotmonk/gold-ts-example/) directory contains a full working demo with a live clock, a real-time users CRUD table, and a chat with image upload.
