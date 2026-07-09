# AGENTS.md

## Project Overview

This repository contains a Google AI Studio exported app for hospital medical equipment operations.
It is a Vite + React + TypeScript frontend with an Express server in `server.ts`.
The app includes AI-assisted repair intake, medical equipment archives, role simulation, and Gemini/OpenAI-compatible model configuration.

## Repository Expectations

- Keep changes small and scoped to the requested feature or fix.
- Prefer existing React, TypeScript, Tailwind, and Express patterns already present in the repo.
- Do not commit secrets. Use `.env.local` locally and GitHub secrets in CI/deployment.
- Treat `GEMINI_API_KEY` as optional for build/test checks. Runtime AI features should fail gracefully or use the existing rule-based fallback when a key is missing.
- Preserve Chinese product copy unless the task explicitly asks for localization changes.
- Avoid unrelated formatting churn in large files such as `src/App.tsx` and `src/components/EquipmentArchives.tsx`.

## Development Commands

- Install dependencies: `npm install`
- Start local dev server: `npm run dev`
- Type-check: `npm run lint`
- Workflow checks: `npm run verify`
- Production build: `npm run build`
- Start production build: `npm run start`

## Verification

Before opening a pull request or handing off code:

- Run `npm run lint`.
- Run `npm run verify` after changing task status flow, role visibility, routing, equipment sync, or date helpers.
- Run `npm run build`.
- For server/API changes, start the built app with `npm run start` and verify `GET /api/health` returns `{ "status": "ok" }`.
- For frontend UI changes, smoke-test the affected screen at `http://127.0.0.1:3000`.

## Review Guidelines

- Check for accidental exposure of API keys, patient identifiers, or other sensitive operational data.
- Check that AI-provider settings do not move secrets into source-controlled files.
- Pay attention to state persisted in `localStorage`; changes should preserve existing saved user data where possible.
- For workflow/status changes, verify task status transitions and log entries remain understandable for hospital equipment staff.
- For large component edits, prefer extracting focused helpers/components over adding more branching to already large files.
