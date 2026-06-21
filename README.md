# Transaction Splitter

Split shared purchases across people and categories, then push transactions directly to YNAB or Splitwise.

[GitHub](https://github.com/AdamGagorik/transaction-splitter) · [Live app](https://adamgagorik.github.io/transaction-splitter/)

![GitHub last commit](https://img.shields.io/github/last-commit/AdamGagorik/transaction-splitter)
![GitHub deployments](https://img.shields.io/github/deployments/AdamGagorik/transaction-splitter/github-pages?label=deploy)

---

## Quick start

1. Enter each item on the **Split** tab — amount, payee, category, who it's for, and what fraction they owe.
2. Add a tip or fee at the bottom if needed; tax is applied per-row when checked.
3. The **By Category** and **By Person** tables update automatically.
4. Use **Copy Summary** to copy a formatted breakdown and paste it into an email.
5. Use **Save as PDF** to print or export.

---

## YNAB integration

1. Go to **app.ynab.com → My Budget → Account Settings → Developer Settings** and create a Personal Access Token.
2. Paste the token into the **API Key** field on the YNAB tab.
3. Set your budget name, purchase account, and tracking accounts (Payable / Receivable).
4. On the YNAB tab, review each transaction preview, choose the direction (you owe / owed to you) per person, then click **Submit to YNAB**.

Categories are matched by name to your YNAB budget at submit time. Use *Group : Category* format in the Split tab (e.g. `Food : Groceries`) to match YNAB's group and category names.

---

## Splitwise integration

1. Go to **splitwise.com → Account → Your Account → Apps** and create a Personal Access Token.
2. Paste the token into the **API Key** field on the Splitwise tab.
3. Set the description, date, currency, and optionally a Group ID.
4. Click **Fetch Friends** to load your Splitwise contacts. Assignees are auto-matched to friends by first name; use the dropdowns to adjust any that didn't match.
5. Choose who paid using the **Payer** dropdown.
6. Review the expense preview and click **Submit to Splitwise**.

A comment is automatically posted to the expense with a full per-person and per-category breakdown.

### Proxy setup (required for browser access)

Splitwise blocks direct browser API calls (CORS). A small Cloudflare Worker acts as a proxy:

1. Sign up at [cloudflare.com](https://cloudflare.com) (free, no credit card).
2. Go to **Workers & Pages → Create Application → Workers** and create a new Worker.
3. Paste the contents of [`workers/splitwise-proxy.js`](workers/splitwise-proxy.js) into the editor and deploy.
4. Copy the worker URL and set `splitwiseProxyUrl` in `config.json`.

The proxy only accepts requests from `adamgagorik.github.io` (and localhost).

---

## Add to iPhone home screen

1. Open [adamgagorik.github.io/transaction-splitter](https://adamgagorik.github.io/transaction-splitter/) in **Safari**.
2. Tap the **Share** button (box with arrow at the bottom of the screen).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The app will open full-screen like a native app.

---

## Config tab

The **Config** tab lets you manage the default rosters for people, categories, and payees shown in the dropdowns. **Load Defaults** reloads from `config.json`. **Clear Local Storage** resets everything — rows, settings, and YNAB/Splitwise fields — back to defaults.

### config.json reference

| Key | Description |
|---|---|
| `defaultPeople` | Default assignee list |
| `defaultCategories` | Default category list |
| `defaultPayees` | Default payee list |
| `ynabBudgetName` | YNAB budget name |
| `ynabPurchaseAcct` | YNAB account for purchases |
| `ynabPayableAcct` | YNAB account for amounts you owe |
| `ynabReceivableAcct` | YNAB account for amounts owed to you |
| `splitwiseProxyUrl` | Cloudflare Worker URL for the Splitwise proxy |

---

*All data is stored locally in your browser. Nothing is sent anywhere except to the YNAB or Splitwise APIs when you click Submit.*
