# Spec 4/5 — Subscriptions (Admin CRUD)

> Depends on Spec 1 (foundation, auth, modal patterns not yet established — this spec introduces the modal component).
> Route: `/subscriptions`. **Admin-only** — every other role sees a 403 panel, enforced client-side for UX and **must also be enforced server-side**.

## 1. Shape

```ts
type Subscription = {
  id: string
  name: string
  subscription_id: string   // Azure subscription GUID
  tenant_id: string          // Azure AD tenant GUID
  client_id: string          // service principal / app registration client ID
  is_active: boolean
  created_at: string
  last_audit_at: string | null
}
```

Note: a real service-principal **client secret** is part of creating/editing a subscription (see §4) but is **never** part of the read shape above — it's write-only, exactly like the prototype models it. Never have the backend return a stored secret in any GET response.

## 2. Access gate

```
if (user?.role !== 'admin') → render:
  ShieldOff icon, "403 — Access Denied", "Only admins can manage subscriptions."
```
Same pattern reused in Spec 5 (Users).

## 3. Page layout

Header: "Subscriptions". Below it, a row with:
- Left: a caption line, e.g. `"{n} Azure subscriptions · client secrets are encrypted and never shown again"` — adjust wording to match your actual security posture (say specifically how secrets are protected if you want to be more precise than the prototype's placeholder claim).
- Right: primary "Add Subscription" button, opens the add modal.

### Table
Columns: **Name** · **Subscription ID** (truncated, monospace) · **Tenant ID** (truncated, monospace) · **Client ID** (truncated, monospace) · **Status** (Active/Inactive badge) · **Last Audit** (formatted date, or "Never") · **Actions** (edit / toggle active / delete icon buttons).

Truncate the three GUID columns to a short prefix + ellipsis (e.g. first 13 chars) — full values aren't useful at a glance and this is a common pattern already used elsewhere in the app for audit/subscription IDs (see Spec 1 §11, `shortId`-style helpers).

## 4. Add / Edit modal

Build a reusable `<Modal title onClose>` component now (used again in Spec 5): fixed-position overlay with a backdrop-blur scrim that closes the modal on click, a centered card with a header (title + close button) and a body slot, scrollable if content overflows the viewport height.

Form fields (same set for add and edit):
- **Name** — text
- **Subscription ID** — text, monospace, GUID placeholder
- **Tenant ID** — text, monospace, GUID placeholder
- **Client ID** — text, monospace, GUID placeholder
- **Client Secret** — password input, monospace
  - On **add**: required, this is how the service principal is authenticated.
  - On **edit**: optional — placeholder text "Leave blank to keep existing secret", only sent to the backend if the admin actually typed a new value (don't send an empty string that would blank out the stored secret).
  - Helper caption under the field: something accurate about how it's handled server-side (encrypted at rest, write-only, never echoed back).
- **Active toggle** — a switch, label "Active — include in daily audits" (or whatever your actual scheduling description is).

Save button:
- **Add mode**: calls the backend create-subscription endpoint with all fields; on success, close the modal and refresh the list (either optimistically prepend the returned record, or refetch).
- **Edit mode**: calls the backend update-subscription endpoint with the changed fields (omit `client_secret` entirely from the payload if left blank); on success, close and refresh.
- Basic client-side validation before submit: `name` and `subscription_id` required at minimum — mirror whatever validation the backend enforces so the error doesn't have to round-trip to be caught.
- Surface backend validation errors (e.g. duplicate subscription ID) inline in the modal, not as a silent failure.

## 5. Row actions

- **Edit** (pencil icon) → opens the modal pre-filled with this row's data (secret field left blank).
- **Toggle active** (power icon) → calls an update endpoint flipping `is_active`; reflect the new state immediately (optimistic update or refetch).
- **Delete** (trash icon, danger-styled) → calls the delete endpoint. **Add a confirmation step before deleting** — the prototype deletes instantly with no confirmation, which is fine for a mock but risky for real Azure subscription configs tied to live scheduled audits. Use a confirm dialog or a two-step "click again to confirm" affordance.

## 6. Definition of done

- Non-admins get the 403 panel; admins see the full table.
- Add/edit/delete/toggle all round-trip through the real backend, with the list reflecting server state after each action (not just local optimistic state that could drift).
- Client secret is never displayed after creation, never pre-filled in the edit form, and omitted from the update payload when left blank.
- Delete requires confirmation.
- Backend independently enforces admin-only access to all of these endpoints (frontend role gate is UX only, not the security boundary).

---
**Next:** Spec 5 — Users (admin CRUD, role management). Ask for it once this one is implemented and reviewed.
