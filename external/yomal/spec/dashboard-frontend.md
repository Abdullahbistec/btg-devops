# BTG DevOps Dashboard — Frontend Specification

## What Is This

BTG DevOps Dashboard is an internal web application for BISTEC Global that gives DevOps engineers and management a visual interface to audit, analyze, and understand their Azure infrastructure.

The CLI tool runs automatically every day (via GitHub Actions) and saves a snapshot of all Azure resources to a PostgreSQL database. This dashboard reads those snapshots, lets users browse the audit history, and uses Claude AI to analyze the data and answer questions in plain English.

**The dashboard is the only place where Claude AI is used.** The CLI just collects data — no AI during collection.

---

## Tech Stack

- **Framework:** Next.js 16, App Router, TypeScript
- **Styling:** Tailwind CSS
- **Charts:** Recharts
- **API:** Already built — Next.js API routes inside `app/api/`
- **Auth:** JWT stored in httpOnly cookie
- **AI:** Anthropic API (Claude claude-sonnet-4-6) — called from the backend, never from the browser

---

## User Roles

| Role | What They Can Do |
|---|---|
| `admin` | Everything — manage users, view all audits, run analysis, use chat |
| `analyst` | View audits, run Claude analysis, use chat — cannot manage users |
| `viewer` | Read-only — can see audit results but cannot run analysis or chat |

---

## Pages to Build

### 1. Login Page — `/login`

**What it does:** Authenticates the user and stores a JWT token.

**Layout:**
- Centered card on a dark background
- BTG DevOps logo / title at the top
- Email input field
- Password input field
- "Sign In" button
- Error message area (wrong credentials, server error)

**Flow:**
1. User enters email + password
2. Clicks Sign In
3. Frontend calls `POST /api/auth/login` with `{ email, password }`
4. On success → JWT token received → stored in httpOnly cookie → redirect to `/dashboard`
5. On failure → show error message "Invalid email or password"

**Notes:**
- No registration page — admin creates users via the Users page
- If user is already logged in and visits `/login` → redirect to `/dashboard`
- All other pages redirect to `/login` if not authenticated

---

### 2. Dashboard Home — `/dashboard`

**What it does:** Shows an overview of the latest audit and key stats at a glance.

**Layout:**
- Top navigation bar (logo, nav links, user name + role badge, logout button)
- Stat tiles row (4 tiles across the top)
- Resource breakdown chart (bar chart)
- Recent audits table (last 5 audits)

**Stat tiles:**
- Total Resources (sum of all resource counts from latest audit)
- Last Audit Time (when the most recent audit ran)
- Subscriptions Monitored (count from subscriptions table)
- Audits This Month (count of audits in current month)

**Bar chart:**
- X axis: resource types (storage, iam, nsg, acr, cosmosdb, keyvault, functions, appservice, appserviceplan, cognitiveservices, resourcegroup, publicip)
- Y axis: count
- Data from latest audit's `resource_counts` field

**Recent audits table columns:**
- Audit ID (short — first 8 chars)
- Date & Time
- Trigger (manual / scheduled)
- Status (completed / failed badge)
- Resource count (total)
- Analysis (✅ cached / ➕ not yet)
- Actions: "View" button

**API calls:**
- `GET /api/audits` — fetch audit list
- `GET /api/subscriptions` — fetch subscription count

---

### 3. Audit List — `/dashboard/audits`

**What it does:** Shows the full history of all audits.

**Layout:**
- Page title "Audit History"
- Filter bar (by status, trigger type, date range)
- Table of all audits (same columns as dashboard home table but full list)
- Pagination (10 per page)

**Table columns:**
- Audit ID (first 8 chars, monospace)
- Subscription ID
- Date & Time
- Trigger (manual / scheduled — shown as a badge)
- Status (completed / failed — colored badge)
- Resource counts summary (e.g. "storage: 23, iam: 197, ...")
- Has Analysis (yes/no)
- Actions: "View Details" button

**API calls:**
- `GET /api/audits` — fetch all audits

---

### 4. Audit Detail — `/dashboard/audits/[id]`

**What it does:** Shows the full detail of one audit. This is the most important page — it has the Claude AI analyze button and the chat interface.

**Layout (split into tabs or sections):**

#### Section A — Audit Summary (always visible at top)
- Audit ID, date, trigger type, status
- Resource count cards (one card per resource type, shows count)
- Subscription name and ID

#### Section B — Claude Analysis (Method 1)
- "Analyze with Claude" button (visible to analyst and admin only, hidden for viewer)
- If `claude_analysis` is already cached in DB:
  - Show the analysis results immediately (no button needed, just display)
  - Show "Analysis cached" badge with the date it was generated
- If not cached:
  - Show the "Analyze with Claude" button
  - On click → loading spinner → calls `POST /api/audits/[id]/analysis`
  - Backend fetches audit data → sends to Claude → saves response → returns
  - Display the response as structured cards

**Claude Analysis response display:**
- Severity summary bar (Critical / Warning / Info counts)
- Findings cards — each card shows:
  - Severity badge (🔴 Critical / 🟡 Warning / 🔵 Info)
  - Category (e.g. "Cost Waste", "Security", "Misconfiguration")
  - Description (what the problem is)
  - Recommendation (how to fix it)
  - Affected resource (which specific resource)

#### Section C — Chat with Claude (Method 2)
- Chat interface (visible to analyst and admin, hidden for viewer)
- Message input at the bottom
- Chat history above
- Example prompt suggestions shown when chat is empty:
  - "What is my biggest cost problem?"
  - "Are there any security risks I should fix immediately?"
  - "Compare this audit with the previous one"
  - "Which resources are unused or idle?"
- On submit → calls `POST /api/audits/[id]/chat` → Claude answers → response shown in chat
- Chat history is saved per audit (stored in DB)

#### Section D — Raw Resource Data (collapsible)
- Collapsible accordion per resource type
- Shows the raw JSON data from the audit in a readable format
- Viewer role can see this

**API calls:**
- `GET /api/audits/[id]` — fetch audit detail
- `POST /api/audits/[id]/analysis` — trigger Claude analysis (analyst/admin)
- `GET /api/audits/[id]/chat` — fetch chat history
- `POST /api/audits/[id]/chat` — send a chat message (analyst/admin)

---

### 5. Users Management — `/dashboard/users`

**What it does:** Admin only page to manage user accounts.

**Layout:**
- Page title "User Management"
- "Add User" button (top right)
- Table of all users

**Table columns:**
- Email
- Role (badge — admin / analyst / viewer)
- Created At
- Actions: Edit role, Delete

**Add User modal:**
- Email input
- Password input
- Role dropdown (admin / analyst / viewer)
- Save button
- Calls `POST /api/users`

**Edit User modal:**
- Role dropdown only (cannot change email)
- Calls `PATCH /api/users/[id]`

**Access:** Admin only — other roles see a "403 Access Denied" message or are redirected.

**API calls:**
- `GET /api/users` — list users
- `POST /api/users` — create user
- `PATCH /api/users/[id]` — update role

---

### 6. Subscriptions — `/dashboard/subscriptions`

**What it does:** Admin only page to manage Azure subscriptions being monitored.

**Layout:**
- Page title "Subscriptions"
- "Add Subscription" button
- Table of subscriptions

**Table columns:**
- Name
- Subscription ID
- Tenant ID
- Client ID
- Status (Active / Inactive badge)
- Last Audit At
- Actions: Edit, Delete, Toggle Active/Inactive

**Add/Edit modal:**
- Name input
- Subscription ID input
- Tenant ID input
- Client ID input
- Client Secret input (masked, write-only — never shown after saving)
- Active toggle
- Save button

**Notes:**
- Client secret is encrypted server-side before saving — never returned via API
- Editing without entering a new client secret keeps the existing encrypted value

**API calls:**
- `GET /api/subscriptions` — list
- `POST /api/subscriptions` — create
- `PATCH /api/subscriptions/[id]` — update
- `DELETE /api/subscriptions/[id]` — delete

---

## Navigation Structure

```
Top Navigation Bar
├── BTG DevOps (logo/title — links to /dashboard)
├── Dashboard (/dashboard)
├── Audits (/dashboard/audits)
├── Subscriptions (/dashboard/subscriptions) [admin only]
├── Users (/dashboard/users) [admin only]
└── [User name + role badge] [Logout button]
```

---

## Design Guidelines

**Color theme:** Dark mode by default (suits DevOps tooling)

**Colors:**
- Background: `#0f172a` (dark navy)
- Card background: `#1e293b`
- Border: `#334155`
- Primary accent: `#3b82f6` (blue)
- Critical/danger: `#ef4444` (red)
- Warning: `#f59e0b` (amber)
- Success/info: `#22c55e` (green)
- Text primary: `#f1f5f9`
- Text secondary: `#94a3b8`

**Severity badge colors:**
- Critical → red background, white text
- Warning → amber background, dark text
- Info → blue background, white text

**Font:** System font stack (no external fonts needed)

**Spacing:** Consistent padding — cards use `p-6`, page containers use `px-6 py-8`

---

## API Endpoints Reference (Already Built)

All these routes exist in `dashboard/app/api/`:

```
POST   /api/auth/login                              — login, returns JWT
POST   /api/auth/logout                             — logout

GET    /api/audits                                  — list all audits
GET    /api/audits/[id]                             — get one audit

POST   /api/audits/[id]/analysis                   — trigger Claude analysis (analyst/admin)

GET    /api/audits/[id]/chat                        — get all chat messages for audit
POST   /api/audits/[id]/chat                        — send new chat message (analyst/admin)
GET    /api/audits/[id]/chat/[messageId]            — get one message
PATCH  /api/audits/[id]/chat/[messageId]            — edit a message (analyst/admin)
DELETE /api/audits/[id]/chat/[messageId]            — delete a message (admin)

GET    /api/audits/[id]/findings                    — get all findings for audit
POST   /api/audits/[id]/findings                    — save findings (analyst/admin)
GET    /api/audits/[id]/findings/[findingId]        — get one finding
PATCH  /api/audits/[id]/findings/[findingId]        — update a finding (analyst/admin)
DELETE /api/audits/[id]/findings/[findingId]        — delete a finding (admin)

GET    /api/audits/[id]/resources/[slug]            — get one resource type from an audit (e.g. slug=storage)

GET    /api/resources                               — list all resource type definitions
POST   /api/resources                               — create resource type (admin)
GET    /api/resources/[slug]                        — get resource type by slug
PATCH  /api/resources/[slug]                        — update resource type (admin)
DELETE /api/resources/[slug]                        — delete resource type (admin)

GET    /api/users                                   — list users (admin)
POST   /api/users                                   — create user (admin)
PATCH  /api/users/[id]                              — update user role (admin)

GET    /api/subscriptions                           — list subscriptions (admin)
POST   /api/subscriptions                           — create subscription (admin)
PATCH  /api/subscriptions/[id]                      — update subscription (admin)
DELETE /api/subscriptions/[id]                      — delete subscription (admin)
```

---

## Exact API Response Shapes (TypeScript)

These are the real types returned by the API — use these field names exactly when building the frontend.

```typescript
interface User {
  id: string
  email: string
  role: string            // 'admin' | 'analyst' | 'viewer'
  is_active: boolean
  created_at: Date
  last_login: Date | null
}

interface Audit {
  id: string
  created_at: Date
  subscription_id: string
  subscription_name: string
  trigger_type: string    // 'scheduled' | 'manual'
  status: string          // 'running' | 'completed' | 'failed'
  error_message: string
  resource_counts: Record<string, number>  // e.g. { storage: 23, iam: 197, ... }
  has_analysis: boolean   // true if claude_analysis is cached
}

interface AuditDetail extends Audit {
  raw_data: Record<string, unknown>           // full clean JSON per resource type
  claude_analysis: Record<string, unknown> | null
}

interface Finding {
  id: string
  audit_id: string
  severity: 'Critical' | 'Warning' | 'Info'
  resource_type: string   // e.g. 'storage', 'iam', 'cosmosdb'
  resource_name: string   // e.g. 'my-storage-account'
  issue: string           // what the problem is (NOT 'description')
  recommendation: string  // how to fix it
  created_at: Date
}

interface ChatMessage {
  id: string
  audit_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: Date
}

interface Subscription {
  id: string
  name: string
  subscription_id: string
  tenant_id: string
  client_id: string
  is_active: boolean
  created_at: Date
  last_audit_at: Date | null
}

interface Resource {
  id: number
  slug: string    // e.g. 'storage', 'iam', 'nsg', 'acr', 'cosmosdb', 'keyvault',
                  //      'functions', 'appservice', 'appserviceplan',
                  //      'cognitiveservices', 'resourcegroup', 'publicip'
  name: string
  description: string
}
```

---

## Authentication Flow

1. User visits any protected page → middleware checks for JWT cookie
2. No JWT or expired → redirect to `/login`
3. Valid JWT → allow access, pass user role to page
4. Role check fails (e.g. viewer tries to access `/dashboard/users`) → show 403 or redirect

JWT is stored in an httpOnly cookie (set by the server on login, cannot be read by JavaScript).

---

## Key UX Rules

1. **Loading states** — every API call shows a spinner or skeleton loader. Never show empty content while loading.
2. **Error states** — every API call handles errors and shows a human-readable message. Never show a raw error object.
3. **Role enforcement** — buttons and sections that require analyst/admin are hidden (not just disabled) for viewer role.
4. **Empty states** — if no audits exist yet, show a helpful message: "No audits yet. The CLI runs daily at 1:30 PM Sri Lanka time."
5. **Responsive** — works on laptop screens (1280px+). Mobile is not a priority.
6. **Chat UX** — chat input stays at the bottom, messages scroll up. "Send" on Enter key or button click.

---

## What Claude Needs to Build (Prototype)

Build the full frontend prototype with:

1. All 6 pages listed above
2. Navigation between pages
3. Mock data where API calls are not yet wired (so the prototype shows realistic content)
4. Dark mode design using the colors above
5. Working login form (can mock the auth for prototype)
6. Recharts bar chart on the dashboard home
7. Claude analysis section with mock findings cards
8. Chat interface with mock responses

The API routes are already built at `dashboard/app/api/` — the frontend just needs to call them.
