# DraftPage

DraftPage is a small web app for reviewing HTML pages. Upload a page, get versions, and let reviewers pin threaded comments directly onto the rendered page, like design-tool comments. Start a thread with **`@Claude`** and an AI proposes the edit as a new **draft** version. A human always reviews and publishes it; the AI never publishes and never resolves a thread.

It's a personal portfolio project for hands-on work with a containerized web app on AWS (ECS/Fargate, RDS, SQS, Lambda, Bedrock), kept deliberately small.

> Status: **Phase 1, local app.** AWS deployment and the cloud AI worker come in later phases (see [Roadmap](#roadmap)).

## Features

- Upload HTML (file, drag-and-drop or paste) → a page with a stable short link.
- Versions: v1, v2, …; exactly one can be **live** (enforced by the database).
- Pinned threads anchored to an element and an offset inside it, so markers follow layout changes and slide decks.
- Threads from earlier versions carry forward while they're still open.
- `@Claude` requests (a thread's opening message) are recorded for the AI worker.
- Export a version's review as Markdown.
- Sign-in with Google through Auth0. Access is granted in Auth0, and the app fails closed without it.

## Stack

| | |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript 7 |
| Styling | Tailwind CSS 4 |
| Data | PostgreSQL 18, Drizzle ORM |
| Auth | Auth0 (`@auth0/nextjs-auth0` v4), Google connection |
| Tests | Vitest 5 against a real Postgres; Playwright browser tests |
| Runtime | Node.js 24 LTS |

## Architecture

```
Browser ──► Next.js app ──► src/server/core (all rules + authorization) ──► PostgreSQL
              │                   ▲
              │                   └── Phase 3: AI worker (Lambda) reuses the same core
              └── sandboxed <iframe> ◄── /api/versions/:id/frame (uploaded HTML + bridge script)
```

- **One domain layer.** Route handlers are thin. Every operation goes through `src/server/core/*` with an explicit actor (a signed-in member, or later the AI assistant scoped to one job).
- **Untrusted HTML is isolated.** Uploaded pages render in `sandbox="allow-scripts"` (no `allow-same-origin`) and are served with a CSP `sandbox` header, so page scripts can't reach the app's cookies or API. A small injected bridge reports clicks, selections and marker positions to the app via `postMessage`.
- **Invariants live in the database:** one live version per page, unique version and message numbers, author-kind checks, marker coordinate ranges.

## Local development

Requirements: Node 24 (`nvm use`), Docker, a personal Auth0 tenant with a Google connection.

```bash
npm ci
cp .env.example .env.local        # fill in your Auth0 application values
docker compose up -d              # Postgres 18 on localhost:5440
npm run db:migrate
npm run dev                       # http://localhost:6500
```

### Environment variables

| Variable | Purpose |
|---|---|
| `DRAFTPAGE_DATABASE_URL` | Postgres connection string (local development) |
| `DRAFTPAGE_DB_HOST`, `DRAFTPAGE_DB_PORT`, `DRAFTPAGE_DB_NAME`, `DRAFTPAGE_DB_USER`, `DRAFTPAGE_DB_PASSWORD` | Alternative to the URL, used on AWS: ECS injects the user and password from the RDS-managed secret |
| `DRAFTPAGE_DB_IAM_AUTH` | `true` on AWS: the app signs in as the limited `draftpage_app` user with a short-lived IAM token instead of a password (needs `DRAFTPAGE_DATABASE_SSL=verify-full`). The admin password is only used by the migration task. |
| `DRAFTPAGE_DATABASE_SSL` | `false` (default), `require` (encrypted), or `verify-full` (encrypted and the certificate is checked against the RDS CA bundle shipped in the image). Use `verify-full` for RDS. |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL` | Auth0 SDK settings |

Secrets are never committed or baked into images. Locally they live in `.env.local`; on AWS they come from Secrets Manager at runtime.

### Tests

```bash
npm run test:db      # disposable Postgres 18 on localhost:55440
npm test             # unit + integration (Vitest, real Postgres)
npm run test:e2e     # browser tests (Playwright + local Chrome, own server and database)
npm run test:image   # builds the Docker image and smoke-tests it (see below)
npm run typecheck
npm run build
```

### Docker

The production image is a multi-stage build on Node 24 alpine (`Dockerfile`). The runtime stage has only the Next.js standalone server, its static assets, the Drizzle migrations and a small migration runner. It runs as the non-root `node` user, with read-only app files and no `.env` files or secrets (the `.dockerignore` keeps them out of the build context).

```bash
docker build --platform linux/arm64 -t draftpage .
docker run --rm draftpage node migrate/src/server/db/migrate.ts   # one-off: apply migrations
docker run -p 3000:3000 --env-file <your env> draftpage             # the app, on port 3000
```

`npm run test:image` does all of this against a scratch database. It checks the image contents, runs the migrate command, runs smoke tests against the container (health, pages, the Auth0 redirect, and that the dev sign-in is ignored in production), waits for the Docker health check, and stops it with SIGTERM.

## AWS deployment

Infrastructure is Terraform in `infra/`, built one reviewed component at a time. `terraform plan` and `apply` are always run by hand. State is local and gitignored.

```text
browser ──HTTPS──▶ API Gateway (HTTP API) ──VPC Link──▶ Cloud Map ──▶ ECS Fargate task (Next.js, :3000)
                                                                          │  IAM token (15 min)
                                                                          ▼
                                                              RDS PostgreSQL 18 (private subnets)
```

| Piece | Choice and why | ≈ $/month running |
|---|---|---|
| Network | VPC with public subnets (the task) and private subnets (RDS, no route to the internet). No NAT Gateway: the task has a public IPv4 for outbound calls only, and its security group accepts traffic only from the VPC Link. | 3.65 (IPv4) |
| Entry point | API Gateway HTTP API: a stable HTTPS URL with an AWS-managed certificate, reaching the task privately through a VPC Link and Cloud Map. No load balancer. Throttled at 20 req/s (burst 50). | ≈ 0.60 |
| Compute | ECS on Fargate, one 0.25 vCPU / 1 GB ARM64 task. Rolling deploys with an automatic rollback when the new task never gets healthy. | ≈ 8.50 |
| Database | RDS PostgreSQL 18, db.t4g.micro, single-AZ, 20 GB gp3, encrypted, private, deletion protection. | ≈ 14 |
| Secrets | Secrets Manager: the Auth0 secrets (value written from the CLI, never in Terraform) and the RDS-managed admin password (rotated by RDS every 7 days). | 0.80 |
| Database sign-in | The app connects as a limited `draftpage_app` user (data only, no DDL) with 15-minute IAM tokens from its task role. It has no password. The admin password is only used by the one-off migrate task. | 0 |
| Images and logs | ECR (immutable tags, scan on push, keeps the last 5) and CloudWatch Logs (14 days). | < 0.60 |
| Cost guard | An AWS Budget with email alerts, counting usage before credits. | 0 |

Total ≈ $28–29/month while running, ≈ $4/month paused.

### Day to day

```bash
aws login --profile draftpage   # short-lived credentials, no access keys
npm run aws:deploy              # build + push → (you apply) → migrate → (you apply) → check
npm run aws:pause               # app to 0 tasks, database stopped
npm run aws:resume              # database started, 1 app task, health check
npm run aws:db-tunnel           # laptop → production database through the task (ECS Exec)
```

`aws:deploy` never runs Terraform itself. It prints each `plan`/`apply` command and waits. Migrations always run with the new image before the app moves to it, so new code never starts against an old schema. Every script first checks that the session belongs to the DraftPage account, and Terraform's `allowed_account_ids` does the same.

## Security decisions

- Access is managed in Auth0: a post-login Action allows listed Google accounts and adds an access claim. The app requires that claim on every request, so if the Action is missing, nobody gets in.
- Owner-only actions (add version, publish, delete) and author/owner rules for resolving and deleting are enforced in the domain layer, not the UI.
- `@Claude` is detected on the server from the opening message; clients can't set the flag.
- Comment text, excerpts and page HTML are treated as untrusted model input and never reach a shell or command line.
- On AWS: no long-lived credentials anywhere. You sign in with `aws login`, ECS tasks use IAM roles scoped to exactly what they use, and the app signs in to the database with IAM tokens. RDS is unreachable from the internet, and the task accepts traffic only from API Gateway's VPC Link.

## Roadmap

1. **Phase 1:** local app, tests, clean baseline *(done)*.
2. **Phase 2:** AWS web deployment with Terraform (`infra/`): budget alerts, networking, Docker image, ECR, RDS PostgreSQL, Secrets Manager, IAM, ECS/Fargate, CloudWatch Logs, and HTTPS through API Gateway. **Live** *(finishing: redeploy test)*.
3. **Phase 3:** cloud AI. `ai_jobs` and a transactional outbox → SQS → Lambda → Amazon Bedrock → a new draft version plus a Claude reply.
4. **Phase 4:** reliability. Idempotency, retries with backoff and jitter, DLQ, timeouts, cost accounting.
5. **Phase 5:** model evaluation. A benchmark of real edit requests to pick the cheapest model that meets the quality bar.

## Known limitations (by design, for now)

- One Fargate task and no load balancer: no high availability. Deploys start the new task before stopping the old one, but a crash means a short outage until ECS replaces the task.
- API Gateway buffers responses (no streaming) and allows 30 seconds per request.
- The account is on the AWS Free plan, which caps RDS automated backups at 1 day. Take a manual snapshot before risky changes.
- Every member with access can see every page; there are no per-page permissions yet.
- Removing someone's access takes effect at their next sign-in (sessions last at most 7 days).

## Cost-conscious choices

One small Fargate task and one small single-AZ RDS instance are the only fixed costs. SQS, Lambda and Bedrock are pay-per-use and near zero at this scale. No ALB, NAT gateway, Multi-AZ or caches until there's a concrete need. AWS Budget alerts come first.
