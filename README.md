# AkaaPharmacy

Offline-first pharmacy POS, inventory, orders and delivery-handoff system (installable PWA).

**Stack:** React 19 + Vite + TypeScript + Tailwind v4 · Dexie (IndexedDB) for offline · Supabase (Postgres, Auth, RLS, Storage) · `vite-plugin-pwa` · Vercel.

## What's in the box

| Module | Works offline? | Notes |
|---|---|---|
| Point of Sale | **Yes** | Barcode/keyboard-first. Sales save locally, deduct local stock (earliest-expiry-first) and upload automatically. 80 mm receipt. |
| Inventory | View offline; edits online | Batches/expiry, receive stock, adjustments, CSV/Excel bulk import with validation. |
| Sales | Online | Receipts, payment verification (transfer / POS-terminal references), voids, exception review. |
| Orders | Online | placed → payment → pharmacist (Rx) → stock reserved → packed → dispatched → delivered, plus cancel / failed / return. |
| Deliveries | Online | Riders and courier companies see **only their own jobs**; delivery confirmed with the customer's one-time code. |
| Wish List | Online | Unmet-demand register with role-based edit rights and demand insights. |
| Expenses | Online | S/No., description, unit cost, quantity, auto total; month / date-range reports, CSV export, print. |
| Reports, Users, Settings | Online | Sales summary; staff roles; receipt/business settings. |

## Develop

```bash
cp .env.example .env     # public Supabase URL + publishable key
npm install
npm run dev              # http://localhost:5173
npm run typecheck && npm run build
```

## Database

SQL lives in `supabase/migrations/` (applied to the AkaaPharmacy project). Key rules:

* Row-level security on every table; stock, sales and payments change **only** through checked database functions (`process_offline_sale`, `receive_stock`, `order_*`, …), so the stock ledger cannot be bypassed.
* `process_offline_sale` is idempotent (device-generated sale id). It never rejects a sale that already happened; problems (stock shortfall, duplicate payment reference, below-list price, underpayment) are flagged for review.
* Cost prices are hidden from direct reads; use `get_drug_costs()`.
* The stock ledger and audit log are append-only.

## Operations

* **Add staff:** in the app, **Users → Add user**. A one-time temporary password is generated (server function `admin-users`, admin-only); the person must choose their own password at first sign-in.
* **Forgotten password:** staff can use *Forgot password?* on the sign-in page, but Supabase's built-in email only delivers to your own Supabase team members until custom SMTP is configured. Until then an admin uses **Users → key icon** (temporary password), which always works.
* **Change own password:** sidebar → *Account*.
* **Public sign-ups** are disabled in Supabase Auth settings.
* **Paystack:** not wired yet. `record_paystack_payment()` exists for a server-side function that must verify the transaction with Paystack using the secret key (kept in Supabase secrets, never in this repo).

## Deploy (Vercel)

Import the GitHub repo, framework **Vite**, and set:

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

`vercel.json` already contains the SPA rewrite. Add the custom domain in Vercel, then set the Supabase Auth Site URL and redirect URLs to it.

## Known gaps / roadmap

Customer storefront · Paystack · courier mobile app (the restricted rider/courier role and API surface already exist) · supplier & purchase-order screens · profit report from purchase costs · client receipt template · logo/icons (placeholders in `public/`).

## Stock import format (CSV or .xlsx)

One row per **batch**. Header row required. Columns (only `name` is mandatory; `selling_price` is required for new products):

`name, generic_name, category, nafdac_number, barcode, unit_type, cost_price, selling_price, wholesale_price, reorder_level, requires_prescription, batch_number, expiry_date, quantity`

* `expiry_date` as `YYYY-MM-DD`; `quantity` is the physical count for that batch (re-importing the same file never double-counts).
* `requires_prescription`: yes/no. Existing products are matched by barcode, then name, and updated.
* Format the barcode column as **Text** in Excel to keep leading zeros. Download the template from Inventory → Bulk import.

## Testing

* `npm test` runs the unit tests (stock allocation, import validation, password rules, permissions, sync guard).
* `samples/demo-inventory.csv` is **demo data only** (illustrative prices and quantities, not market prices). Import it from Inventory → Bulk import to try the system; it includes an expired batch, items expiring soon, low-stock and out-of-stock items, and prescription items so every alert can be seen. Remove or overwrite it before real use.
