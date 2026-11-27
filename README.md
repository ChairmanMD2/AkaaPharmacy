# AkaaPharmacy

Offline-first pharmacy POS, inventory, orders and delivery-handoff system (installable PWA).

**Stack:** React 19 + Vite + TypeScript + Tailwind v4 · Dexie (IndexedDB) for offline · Supabase (Postgres, Auth, RLS, Storage, Edge Functions) · `vite-plugin-pwa` · Vercel.

## Design priorities

* **Primarily a computer app.** The main use is on the pharmacy's Windows counter PC and on office computers (keyboard and mouse, barcode scanner, thermal printer). Screens are designed desktop-first. Phone and tablet layouts are supported and kept usable (riders and quick admin checks), but desktop speed and ergonomics come first when there is a trade-off.
* **Fast and reliable beats flashy.** Motion is CSS-only and subtle, and it switches off for people who prefer reduced motion.
* **Works offline like a standalone app**: see "How offline works" below.

## Who can sign in and what they can do

Everyone uses the **same web address**. An administrator creates each account in **Users → Add user** (name, email, role, branch). The app shows a one-time **temporary password**; the person signs in with their email and that password, and is made to **choose their own password** straight away. Forgotten password: *Forgot password?* on the sign-in page (needs email set up), or an admin gives a new temporary password (Users → key icon). A person with no branch assigned cannot sell, so always choose a branch.

| Role | Sees in the menu | Can do |
|---|---|---|
| **Administrator** | everything | all of the below, plus Users, Settings, Reports and profit, voids, view audit data, any branch |
| **Pharmacist** | Dashboard, POS, Inventory, Receiving, Sales, Orders, Deliveries, Wish List, Cash-up, Expenses, Reports | sell, approve prescription orders, receive stock, adjust stock, void sales, refund returns, review expenses (own branch) |
| **Cashier** | Dashboard, POS, Inventory (view), Sales, Orders, Wish List, Cash-up, Expenses | sell and take payments, record wish-list items and expenses, verify payments, open/close own shift; **cannot** change stock, void or refund |
| **Inventory officer** | Dashboard, Inventory, Receiving, Orders, Wish List, Expenses | receive and adjust stock, import stock, reserve/pack/dispatch orders; **cannot** sell or see sales |
| **Rider / Courier** | only *My deliveries* | see only their own jobs, mark picked up / failed, confirm delivery with the customer's code; **no** access to stock, sales or other customers |

These limits are enforced in the database (row-level security and checked functions), not only by hiding menu items.

## How offline works

* **Selling** (POS): works fully offline. Sales are saved on the device, stock is deducted locally (earliest expiry first), receipts print with a provisional number, and everything uploads automatically in order when the connection returns. Uploads are idempotent, so a retry never double-posts.
* **Offline sales show up everywhere that matters:** they appear at the top of **Sales** (marked "Waiting to sync"), in **today's sales** on the Dashboard, and in the **Cash-up** figures. Reports show a notice that waiting sales are not yet in the totals.
* **Pages** (dashboard, sales, orders, reports, users, wish list, expenses, receiving history, …) show the **last saved data** when offline instead of an error, and refresh by themselves the moment the connection is back.
* **Saving without internet:** expenses, wish-list entries and edits, new suppliers, **stock receipts**, **order payments** (cash / transfer / POS terminal) and **opening and closing a cash-up shift** are stored on the device and uploaded automatically, in order (sales first, so a shift always closes after its sales). Stock received offline is sellable straight away.
* **Needs a connection by nature (kept online-only on purpose):** creating, reserving and dispatching orders (stock and prices must be decided by the server, and several people work on the same order), delivery confirmation with the customer's code, refunds and voids, payment verification, Paystack, and user management. These pages still *show* saved data offline; the action buttons say they need the internet.
* **Live updates (Supabase Realtime):** when another device changes stock, sales, orders, deliveries, the wish list, expenses or receipts, open screens refresh within a couple of seconds. If the live channel drops, the 60-second refresh and the reconnect sync still keep everything correct.
* **Reconnecting is automatic.** The app does not rely on the browser's "online" flag alone (Wi-Fi without internet still reads as online): it checks the server itself, looks every few seconds while offline, and syncs the instant the server answers. The status pill (top right) shows Online / Offline and how many items are waiting; click it for the list and a manual **Sync now**.
* Data is cached per signed-in user and wiped on sign-out.

## What's in the box

| Module | Notes |
|---|---|
| Point of Sale | Barcode scanner works from anywhere on the screen (see below); hold and resume sales; split payments; cash / transfer / POS-terminal (with required reference) / Paystack; 80 mm receipt. |
| Inventory | Batches and expiry, adjustments, CSV/Excel bulk import with validation. |
| **Receiving** | Receive stock from a supplier: pick or type the supplier, supplier invoice/receipt number, date of supply, date received, many products per invoice. **History** by period (date received or date of supply), by invoice number and by supplier, with totals per supplier and CSV export. Suppliers list. Duplicate supplier invoices are refused. |
| Wish List | Unmet-demand register with insights. **Select several requests → Create invoice** (matches each to a product, shows price and stock, printable) → **Proceed to payment** at the till; paid items are marked fulfilled automatically. |
| Sales | Receipts and reprints, payment verification, voids, customer returns/refunds (discount-aware, expired goods never restocked). |
| Cash-up | Per-cashier shifts: float, expected cash, counted cash, difference with required explanation, printable report. |
| Orders / Deliveries | placed → payment → pharmacist (Rx) → reserved → packed → dispatched → delivered; riders/couriers see only their jobs and confirm with the customer's one-time code. |
| Expenses | S/No., description, unit cost, quantity, auto total; month / date-range reports, CSV, print. |
| Reports, Users, Settings | Sales summary and admin-only profit; staff roles; business details, Paystack switch, printing help. |

## Barcode scanner

A USB or Bluetooth scanner is used like a keyboard: just point it at a pack. The app tells a scan from typing by speed, so it works **without clicking the search box first**, and the barcode never ends up in a text box.

* **Point of Sale:** each scan adds the product to the cart (a second scan adds one more). A high beep means accepted, a low beep means no product has that barcode.
* **Inventory:** a scan finds the product; an unknown barcode (for people allowed to add products) opens "Add product" with the barcode already filled in.
* **Receiving:** a scan puts the product on the next empty row of the invoice.
* **Camera scanning** (Camera button) is offered only where the browser has the built-in `BarcodeDetector` (Chrome/Edge on Android, and some desktop builds). It does not exist in every browser, so a USB scanner is the dependable way on the counter PC.
* Scanners that drop or add a leading zero (UPC-A vs EAN-13) are matched too. If your scanner does not send Enter after each code, set it to "add Enter / CR suffix" (see its manual).

## Paystack

Payments are handled by server functions; the **secret key never reaches the browser or this repo**.

1. In Supabase → **Edge Functions → Secrets**, add `PAYSTACK_SECRET_KEY`.
2. In Paystack's dashboard set the webhook URL to `<project-url>/functions/v1/paystack-webhook` (a backup path).
3. In the app: **Settings → Paystack → Check Paystack connection**, tick *Accept Paystack payments*, Save.

Flow: the till calls `paystack-init`, opens Paystack's page, then `paystack-verify` asks **Paystack directly** whether it was paid (amount in kobo must match exactly). A sale or order only counts a Paystack payment the server has confirmed **and that has not been used before**; otherwise the sale is flagged for review. Webhooks are never trusted on their own: they only trigger the same direct check for a payment this system started.

## Develop

```bash
cp .env.example .env     # public Supabase URL + publishable key
npm install
npm run dev              # http://localhost:5173
npm run typecheck && npm test && npm run build
```

## Database

SQL lives in `supabase/migrations/` (applied in filename order); `supabase/schema.sql` is a complete copy for reference. Edge functions are in `supabase/functions/`. Key rules:

* Row-level security on every table; stock, sales, payments and receipts change **only** through checked database functions (`process_offline_sale`, `receive_stock_invoice`, `order_*`, …), so the stock ledger cannot be bypassed.
* `process_offline_sale` is idempotent (device-generated sale id). It never rejects a sale that already happened; problems (stock shortfall, duplicate payment reference, below-list price, underpayment, unconfirmed Paystack payment) are flagged for review.
* Cost prices are hidden from direct reads; use `get_drug_costs()`.
* The stock ledger and audit log are append-only.

## Operations

* **Add staff:** Users → Add user (see the roles table above).
* **Public sign-ups** are disabled in Supabase Auth settings.
* **Email (SMTP):** Supabase's built-in email only delivers to your own Supabase team members; connect your official email for reset-link emails to reach staff.

## Deploy (Vercel)

Import the GitHub repo, framework **Vite**, and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `vercel.json` already contains the SPA rewrite. Add the custom domain in Vercel (use the DNS records Vercel shows for your project), then set the Supabase Auth Site URL and redirect URLs to it. A merge to `main` deploys to production automatically.

## Installing on the counter PC (Windows)

Open the site in **Chrome or Edge**, click **Install app** in the address bar, and pin it to the taskbar. For one-click silent receipt printing: right-click the desktop shortcut → Properties → add ` --kiosk-printing` at the end of **Target**, and make the thermal printer the Windows default printer. (Also shown in Settings.)

## Matches the architecture guide (PDF v3)

| Guide requirement | Status |
|---|---|
| React (Vite) + Tailwind, `vite-plugin-pwa` (`registerType: 'autoUpdate'`, standalone, offline caching, icons) | Done. App name is "AkaaPharmacy" instead of the guide's sample name; theme colour `#0f766e` as in the guide. |
| Dexie mirrors drugs, drug_batches and branches | Done (plus a read cache, an outbox and held sales). |
| Offline sales queued in `pending_sales`, local stock deducted immediately | Done. |
| Online/Offline pill with pending count, manual **Sync Now**, auto-sync on reconnect | Done; reconnect detection now probes the server itself. |
| Supabase tables: branches, profiles with roles, drugs (NAFDAC, barcode, cost, selling, wholesale price), drug_batches, sales, sale_items, stock_movements | Done. |
| Atomic `process_offline_sale` that logs negative `stock_movements` and decrements batches safely | Done (row locks, earliest-expiry-first, idempotent). |
| RLS: admin manages all branches; pharmacist and cashier only their assigned branch | Done and tested. |
| `supabase/schema.sql` | Done (`supabase/schema.sql`, generated from the migrations). |
| Bulk Import (CSV / Excel) with template, row validation, batch upsert | Done. Uses **`read-excel-file`** + `papaparse` instead of `xlsx`, because `xlsx` on npm has known high-severity vulnerabilities with no fix. |
| 80 mm thermal receipt `@media print` | Done. |
| Optional `--kiosk-printing` shortcut | Documented here and in Settings. |
| `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Done. |
| Vercel from GitHub, custom domain, Supabase Auth URL configuration, first admin | Done except the custom domain (pending). |
| "Real-time sync" (Supabase) | Done: Supabase Realtime pushes stock, sales, orders and list changes to open screens within seconds, backed by a 60-second refresh and a sync on reconnect. |

## Known gaps / roadmap

Customer storefront · courier mobile app (the restricted rider/courier role already exists) · customers screen · purchase orders · stock-take screen · client receipt template · logo/icons (placeholders in `public/`).

## Stock import format (CSV or .xlsx)

One row per **batch**. Header row required. Columns (only `name` is mandatory; `selling_price` is required for new products):

`name, generic_name, category, nafdac_number, barcode, unit_type, cost_price, selling_price, wholesale_price, reorder_level, requires_prescription, batch_number, expiry_date, quantity`

* `expiry_date` as `YYYY-MM-DD`; `quantity` is the physical count for that batch (re-importing the same file never double-counts).
* `requires_prescription`: yes/no. Existing products are matched by barcode, then name, and updated.
* Format the barcode column as **Text** in Excel to keep leading zeros. Download the template from Inventory → Bulk import.

## Testing

* `npm test` runs the unit tests (stock allocation, import validation, password rules, permissions, sync guard, the offline outbox and read cache, offline stock receiving).
* `samples/demo-inventory.csv` is **demo data only** (illustrative prices and quantities, not market prices). Import it from Inventory → Bulk import to try the system; it includes an expired batch, items expiring soon, low-stock and out-of-stock items, and prescription items so every alert can be seen. Remove or overwrite it before real use.
