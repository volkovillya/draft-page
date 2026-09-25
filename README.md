# DraftPage

DraftPage is a small web app for reviewing HTML pages. Upload a page, get versions, and let reviewers pin threaded comments directly onto the rendered page, like design-tool comments. Start a thread with **`@Claude`** and an AI proposes the edit as a new **draft** version. A human always reviews and publishes it; the AI never publishes and never resolves a thread.

It's a personal portfolio project for hands-on work with a containerized web app on AWS (ECS/Fargate, RDS, SQS, Lambda, Bedrock), kept deliberately small.

> Status: **live on AWS (Phase 2), AI pipeline running end to end (Phase 3)** with a stand-in editor until the AWS account can call Bedrock (see [Known limitations](#known-limitations-by-design-for-now)).

## Features

- Upload HTML (file, drag-and-drop or paste) → a page with a stable short link.
- Versions: v1, v2, …; exactly one can be **live** (enforced by the database).
- Pinned threads anchored to an element and an offset inside it, so markers follow layout changes and slide decks.
- Threads from earlier versions carry forward while they're still open.
- `@Claude` requests (a thread's opening message) run as background AI jobs: the thread shows Claude working, then a reply and a new **draft** version to review.
- Owners can delete draft versions (never the live one or the last one).
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
              │                   └── AI worker (Lambda) → internal job API → the same core
              └── sandboxed <iframe> ◄── /api/versions/:id/frame (uploaded HTML + bridge script)
```

- **One domain layer.** Route handlers are thin. Every operation goes through `src/server/core/*` with an explicit actor (a signed-in member, or the AI assistant scoped to one job).
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
| `DRAFTPAGE_AI_LOCAL_WORKER`, `DRAFTPAGE_AI_LOCAL_WORKER_URL` | `on` + the dev server's URL: run AI jobs inside the dev server (a stand-in for SQS + Lambda, running the real worker code). Local development and e2e only. |
| `DRAFTPAGE_AI_QUEUE_URL` | On AWS: the SQS queue the outbox relay publishes AI jobs to |
| `DRAFTPAGE_WORKER_ROLE_ARN` | The IAM role allowed to call `/api/internal/*` (the worker Lambda's). The internal API is off when unset. |
| `DRAFTPAGE_AI_EDITOR`, `DRAFTPAGE_AI_MODEL_ID`, `DRAFTPAGE_AI_REGION` | `fake` (default: no model, an invisible edit) or `bedrock` with a model or inference profile id |
| `DRAFTPAGE_AI_FAKE_DELAY_MS` | Pretend thinking time for the fake editor, so the "working" state is visible locally |

Secrets are never committed or baked into images. Locally they live in `.env.local`; on AWS they come from Secrets Manager at runtime.

### Tests

```bash
npm run test:db      # disposable Postgres 18 on localhost:55440
npm test             # unit + integration (Vitest, real Postgres)
npm run test:e2e     # browser tests (Playwright + local Chrome, own server and database)
npm run test:image   # builds the Docker image and smoke-tests it (see below)
npm run build:worker # bundles the AI worker Lambda into infra/build/ai-worker.zip
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
         outbox relay (in the app) ──▶ SQS draftpage-ai-jobs ──▶ Lambda draftpage-ai-worker
                                           │ 3 failed receives       │ SigV4-signed HTTPS
                                           ▼                         ▼
                                     DLQ ──▶ alarm (email)     API Gateway /api/internal/* (IAM auth) ──▶ app
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
| AI queue | SQS standard queue (18 min visibility, long polling, SSE) plus a dead-letter queue after 3 failed receives. | ≈ 0 |
| AI worker | Lambda, Node 24 on ARM64, 256 MB, 3 min timeout, outside the VPC, at most 2 at once. | ≈ 0 |
| Observability | CloudWatch Logs for the app, the worker and API Gateway access (14 days), and one alarm that emails when a job reaches the dead-letter queue. | ≈ 0.10 |
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

`aws:deploy` never runs Terraform itself. It prints each `plan`/`apply` command, waits, and checks on AWS that the apply really happened before going on. Migrations always run with the new image before the app moves to it, so new code never starts against an old schema. Every script first checks that the session belongs to the DraftPage account, and Terraform's `allowed_account_ids` does the same. After worker code changes, run `npm run build:worker` before `terraform plan`.

## AI processing flow

```text
reviewer: "@Claude make the heading green"
  → one transaction: thread + message + ai_job (pending) + outbox event
  → outbox relay (a timer in the app, SKIP LOCKED) → SQS message { jobId }
  → Lambda: claim the job → model edit → validate → save
  → one transaction: new DRAFT version + Claude's reply + job completed (tokens, cost, latency)
  → the thread shows it; a person reviews and publishes, or not
```

- **Nothing is lost.** The job and its outbox event commit with the comment. A crash before publishing only delays it; the relay retries with exponential backoff and jitter.
- **Duplicates are harmless.** SQS delivers at least once. A job can only produce one version: completing a completed job returns the same version, concurrent completions are serialized by a row lock, and `(thread, base version, kind)` is unique.
- **Failures are bounded and visible.** Temporary errors (throttling, timeouts) retry after ≈30 s and ≈2 min; the third attempt marks the job failed with a short reason shown on the thread. Permanent errors (refused, too large, invalid output) fail at once. A worker that crashes every time leaves the message in the dead-letter queue, which emails an alarm; jobs stuck over 30 minutes are failed by the relay.
- **The AI only ever drafts.** The assistant actor can add a draft version to its own page and reply in its own thread. Publishing, resolving and deleting refuse it before touching the database.
- **The model is behind one interface** (`HtmlEditorModel`): a Bedrock Converse editor and a deterministic fake. Page HTML, the quoted text and the instruction go to the model as clearly delimited untrusted data; results that add scripts, event handlers or `javascript:` links are rejected. Pages over 300 KiB are refused before any call.
- **The worker never touches the database** (decision D11). It runs outside the VPC, so it reaches Bedrock without a NAT Gateway (~$33/month) or a Bedrock VPC endpoint (~$8/month), and reads and saves jobs through two internal endpoints. API Gateway accepts those only when signed with the worker's IAM role, then passes the verified caller to the app, which checks it again.
- **The UI polls** this version's threads every 2 s, only while a job is active and the tab is visible. API Gateway HTTP APIs buffer responses, so a push channel would need a separate WebSocket API; polling costs a few requests per edit.

### Switching to a real model (after leaving the Free plan)

1. Check the model answers from the account: a tiny Converse call with `aws bedrock-runtime converse --profile draftpage --region eu-north-1 --model-id <id> …`.
2. Add `bedrock:InvokeModel` for exactly that model or inference profile to the worker role (`infra/lambda.tf`).
3. Set `ai_editor = "bedrock"` and `ai_model_id = "<id>"` in `infra/terraform.tfvars`, then plan + apply.
4. Write an `@Claude` comment on a test page and read `/aws/lambda/draftpage-ai-worker` for the tokens, cost and latency of the job.

## Security decisions

- Access is managed in Auth0: a post-login Action allows listed Google accounts and adds an access claim. The app requires that claim on every request, so if the Action is missing, nobody gets in.
- Owner-only actions (add version, publish, delete) and author/owner rules for resolving and deleting are enforced in the domain layer, not the UI.
- `@Claude` is detected on the server from the opening message; clients can't set the flag.
- Comment text, excerpts and page HTML are treated as untrusted model input and never reach a shell or command line.
- On AWS: no long-lived credentials anywhere. You sign in with `aws login`, ECS tasks and the Lambda use IAM roles scoped to exactly what they use, and the app signs in to the database with IAM tokens. RDS is unreachable from the internet, and the task accepts traffic only from API Gateway's VPC Link.
- The worker's internal API is IAM-authorized at the gateway (SigV4, one role, POST to `/api/internal/ai-jobs/*` only) and checked again in the app. Public requests can't forge the caller header: API Gateway overwrites it on every other route.

## Roadmap

1. **Phase 1:** local app, tests, clean baseline *(done)*.
2. **Phase 2:** AWS web deployment with Terraform (`infra/`): budget alerts, networking, Docker image, ECR, RDS PostgreSQL, Secrets Manager, IAM, ECS/Fargate, CloudWatch Logs, and HTTPS through API Gateway *(done)*.
3. **Phase 3:** cloud AI. `ai_jobs` and a transactional outbox → SQS → Lambda → Amazon Bedrock → a new draft version plus a Claude reply *(running with the stand-in editor; Bedrock after leaving the Free plan)*.
4. **Phase 4:** reliability. Idempotency, retries with backoff and jitter, DLQ and timeouts are in place; next are metrics from the job table and cost reports.
5. **Phase 5:** model evaluation. A benchmark of real edit requests to pick the cheapest model that meets the quality bar.

## Known limitations (by design, for now)

- One Fargate task and no load balancer: no high availability. Deploys start the new task before stopping the old one, but a crash means a short outage until ECS replaces the task.
- API Gateway buffers responses (no streaming) and allows 30 seconds per request.
- The account is on the AWS Free plan, which caps RDS automated backups at 1 day (take a manual snapshot before risky changes) and gives Bedrock 0 tokens a day. Until the upgrade, AI jobs run with the stand-in editor, which makes an invisible edit; the rest of the pipeline is real.
- Pins remember elements by position (for example "the first `div`"), so an edit that inserts elements earlier on the page can move them in the new version.
- Follow-up `@Claude` requests in replies aren't supported yet: one thread is one request.
- Every member with access can see every page; there are no per-page permissions yet.
- Removing someone's access takes effect at their next sign-in (sessions last at most 7 days).

## Cost-conscious choices

One small Fargate task and one small single-AZ RDS instance are the only fixed costs. SQS, Lambda and Bedrock are pay-per-use and near zero at this scale. No ALB, NAT gateway, Multi-AZ or caches until there's a concrete need. AWS Budget alerts come first.
