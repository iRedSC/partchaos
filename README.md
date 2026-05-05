# partchaos

An ultra-lightweight React app using local stock shadcn/ui components, Convex data, and passkey auth.

## Setup

Install dependencies:

```sh
npm install
```

Set the universal password in Convex:

```sh
npx convex env set UNIVERSAL_PASSWORD "your-shared-password"
```

For production, also pin the WebAuthn origin so passkeys cannot be created or used from another host:

```sh
npx convex env set SITE_ORIGIN "https://your-domain.example"
```

Run Convex and Vite in separate terminals:

```sh
npx convex dev
npm run dev
```

## Auth Model

There are no accounts. The `UNIVERSAL_PASSWORD` only authorizes creating global passkeys. Any registered passkey can sign in and receive a simple session token for reading and writing the shared Convex list.
