# Spec 5/5 — Users (Admin CRUD, Role Management)

> Depends on Spec 1 (foundation, auth) and Spec 4 (the shared `<Modal>` component — reuse it, don't rebuild it).
> Route: `/users`. **Admin-only** — every other role sees a 403 panel, enforced client-side for UX and **must also be enforced server-side**. Same 403 pattern as Spec 4 §2.

## 1. Shape

```ts
type Role = 'admin' | 'analyst' | 'viewer'

type User = {
  id: string
  email: string
  role: Role
  is_active: boolean
  created_at: string
  last_login: string | null
}
```

## 2. Access gate

Identical pattern to Subscriptions:
```
if (user?.role !== 'admin') → render:
  ShieldOff icon, "403 — Access Denied", "Only admins can manage users."
```

## 3. Page layout

Header: "User Management". Below it, a row with:
- Left: caption, e.g. `"{n} accounts · admin creates all users, no self-registration"` — keep this claim accurate to your real system (if you *do* support self-registration or SSO-provisioned accounts, adjust the copy and the add-user flow accordingly).
- Right: primary "Add User" button, opens the add modal.

### Table
Columns: **Email** · **Role** (badge: admin/analyst/viewer) · **Status** (Active/Inactive badge) · **Created At** · **Last Login** (formatted date, or "Never" if `last_login` is null) · **Actions** (edit role / delete icon buttons).

## 4. Add User modal

Reuse the `<Modal>` component from Spec 4. Fields:
- **Email** — text, email placeholder
- **Password** — password input. Only relevant if your backend actually issues local passwords; if your real auth is SSO/OAuth/magic-link, replace this with whatever provisioning your identity provider needs (e.g. just email + role, and the invite/first-login flow handles credentials) — don't blindly copy a password field if it doesn't match your actual auth model.
- **Role** — select: Admin / Analyst / Viewer

Save → calls the backend create-user endpoint. On success, close modal and refresh the list. Validate email + password (or whatever your real required fields are) client-side before submit, mirroring backend validation.

## 5. Edit Role modal

A **role-only** edit — the prototype deliberately doesn't let admins change a user's email from this modal (shown as read-only text: "Email cannot be changed"). Keep that restriction unless your real system explicitly needs email changes to go through this flow (usually email changes are a separate, more sensitive flow — e.g. requiring re-verification).

Field: **Role** select (Admin / Analyst / Viewer), pre-filled with the user's current role. Save → calls the backend update-role endpoint for that user ID.

**Important real-world addition not in the prototype**: guard against an admin demoting or deleting **their own** account (or the last remaining admin account) and locking everyone out of admin access. Either disable those actions in the UI for the current user's own row / the last admin, or surface a clear backend error if that safety check lives server-side instead.

## 6. Row actions

- **Edit role** (pencil icon) → opens the Edit Role modal.
- **Delete** (trash icon, danger-styled) → calls the delete-user endpoint. Same as Spec 4: **add a confirmation step** before deleting — removing a real user account (and losing the audit trail of who ran what) is not something that should happen from a single accidental click.

## 7. Definition of done

- Non-admins get the 403 panel; admins see the full table.
- Add/edit-role/delete all round-trip through the real backend, list reflects server state after each action.
- Email is immutable from the Edit Role modal.
- Delete requires confirmation.
- Self-demotion / last-admin-lockout is prevented or clearly blocked with an error.
- Backend independently enforces admin-only access to all of these endpoints.

---

## Rollout note (all 5 specs)

Implement in order — **1 → 2 → 3 → 4 → 5** — since each later spec assumes the layout shell, auth context, and shared components (`Badge`, `Modal`, `KPICard`, `formatNumber`/`shortId`/`cn` helpers, the `.glass`/`.btn-*`/`.bdg-*` CSS classes) from earlier specs already exist. After all five are done, do a pass to remove any leftover mock/demo artifacts (seed data, hardcoded demo credentials, fake timers standing in for real backend latency) that may have been used as placeholders during development.
