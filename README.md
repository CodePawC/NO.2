# CodePawC NO.2

Hospital medical equipment operations prototype exported from Google AI Studio and prepared for ongoing GitHub + Codex development.

The app provides an AI-assisted repair intake workflow, medical equipment archives, simulated clinical/engineer roles, equipment maintenance records, and Gemini/OpenAI-compatible model settings.

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Express
- Google Gemini SDK (`@google/genai`)

## Repository Layout

```text
.
├── src/
│   ├── App.tsx
│   ├── components/
│   ├── data/
│   └── types.ts
├── server.ts
├── vite.config.ts
├── .env.example
├── AGENTS.md
└── .github/workflows/ci.yml
```

## Prerequisites

- Node.js 22 or newer
- npm
- Optional: Gemini API key for live AI calls

## Local Development

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Set `GEMINI_API_KEY` in `.env.local` if you want cloud AI features. The app can still build and run without it; AI calls fall back to local rule-based behavior where implemented.

Start the development server:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

## Available Scripts

```bash
npm run dev
```

Runs the Express server with Vite middleware.

```bash
npm run lint
```

Runs TypeScript checking with `tsc --noEmit`.

```bash
npm run verify
```

Runs lightweight workflow checks for role permissions, task transitions, transfer routing, equipment archive sync, and local date helpers.

```bash
npm run build
```

Builds the Vite frontend and bundles `server.ts` into `dist/server.cjs`.

```bash
npm run start
```

Starts the production build from `dist/server.cjs`.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | No for build, yes for live Gemini calls | Gemini API key used by server-side AI endpoints. |
| `APP_URL` | No | Public app URL for hosted/self-referential workflows. |

Do not commit `.env.local` or real API keys.

## CI

GitHub Actions runs on pushes and pull requests targeting `main`.

The workflow performs:

1. Dependency installation
2. TypeScript check
3. Workflow verification
4. Production build
5. Production server smoke test against `/api/health`

CI does not require `GEMINI_API_KEY`.

## Development Workflow

Recommended flow:

1. Use Google AI Studio for quick prototype ideas.
2. Push or export code into GitHub.
3. Use Codex and pull requests for structured development, review, testing, and deployment work.
4. Keep `main` as the stable source of truth.

## Notes for Codex

Codex-specific repository guidance lives in `AGENTS.md`.

Future engineering priorities:

- Split the large React components into focused pages, hooks, and services.
- Move durable production data out of `localStorage`.
- Keep provider API keys on the server side for production deployments.
- Expand workflow checks toward browser-level role smoke tests as the UI is split into smaller modules.
