# CharpstAR integration client (reference implementation)

A small, dependency-free Node program that shows the CharpstAR Integration API loop:

1. **Send products** from your catalogue to CharpstAR (`POST /api/v1/products`).
2. **Follow your orders** (`GET /api/v1/orders`): the status of each order and of each item in it.
3. **Get told when 3D is ready**, by webhook (`asset.approved`, `asset.images.updated`, `status.changed`) or by polling.
4. **Fetch the result** (`GET /api/v1/assets/...`): status, 3D viewer link, AR link, GLB/USDZ files, embed snippet and images, and save it all to `out/<article>/`.
5. **Make packshots** of delivered models (`POST /api/v1/jobs`) and save the pictures to the same folder.

The documentation is at https://charpstar.co/docs. The API reference, with every call, field and error, is at
https://charpstar.co/docs/api. This README covers the calls the client uses.

Copy it, run it against your key, then swap the two ends for your own system:
- `src/catalogue.ts`: where products come from (here a JSON/CSV file; for you, your ERP or PIM).
- `src/download.ts`: where results go (here a folder; for you, links on the ERP item and images in your DAM).

Everything in between (signing, retries, idempotency, polling cursor) can stay as it is.

Requirements: **Node.js 22.18 or newer** (it runs the TypeScript sources directly). No `npm install` is needed to run it.
An older Node 22 needs a flag: `node --experimental-strip-types src/index.ts check`.

## Quick start

You make an API key in your CharpstAR account, under Settings, then Developer. Give it the scopes of the commands you
will run (see [Scopes](#scopes)).

```bash
cp .env.example .env                       # paste your CHARPSTAR_API_KEY
cp catalogue.example.json catalogue.json   # then replace the examples with your products
node src/index.ts check                    # prints your client and the key's scopes
node src/index.ts push --dry-run && node src/index.ts push
node src/index.ts poll                     # every 5 min: push changes, download finished 3D
```

`push --dry-run` prints exactly what would be sent and needs no key. The example products are called
`EXAMPLE-...`: **replace them before a real `push`**, or they will show up as products in your account.

## Commands

| Command | What it does |
|---|---|
| `check` | `GET /api/v1/me`: confirms the key works and shows its client and scopes. |
| `push [--dry-run]` | Reads `CATALOGUE` and sends every product that changed since the last accepted push. |
| `pull <article>... [--dry-run]` | Downloads links and approved images for those articles into `out/<article>/`. |
| `listen` | Starts the webhook receiver on `WEBHOOK_PORT`. See [Webhooks](#webhooks) for what it does with each event. |
| `poll [--once] [--dry-run]` | For setups that can't receive webhooks: `push`, then download everything that changed since the last poll; repeats every `POLL_MINUTES`. |
| `orders [orderId]` | Without an id: lists your orders with their status and item counts. With an id: that order and the status of each item. |
| `render <article>... [--preset <name>] [--dry-run]` | Starts a packshot job for each article, waits for the jobs to finish and saves each picture into `out/<article>/`. `--dry-run` prints the request and needs no key. |
| `smoke [catalogue]` | A one-off check of your key against the API: `me`, push the whole catalogue, read each accepted article, one `since` poll. Prints a JSON summary and touches neither `state.json` nor `out/`. |

Logs are one JSON object per line on stdout, for example
`{"t":"2026-10-20T09:31:02.000Z","level":"info","msg":"push.result","article":"CH-1001","result":"created","status":"received","httpStatus":201}`.
API keys and secrets are masked in logs.

### Scopes

A key carries one or more scopes. `check` lists the scopes of your key.

| Command | Scopes the key needs |
|---|---|
| `check` | none: any valid key |
| `push` | `products:write` |
| `pull` | `assets:read` |
| `listen` | `assets:read` |
| `poll` | `products:write` and `assets:read` |
| `orders` | `products:read` |
| `render` | `jobs:write` to start the jobs, `jobs:read` to read them and to check a `--preset` |
| `smoke` | `products:write` and `assets:read` |

A call with a key that lacks its scope answers `403 forbidden` with `details.reason` `missing_scope`, and `details.scope`
names the scope. The command then stops with one line, for example:

```
fatal: The API key does not have the scope jobs:write, which POST /api/v1/jobs needs. Use a key with that scope ("check" lists the scopes of a key).
```

`listen` keeps running: it logs the same sentence in a `webhook.failed` line and answers `503`.

### Smoke test

```bash
node src/index.ts smoke
```

It uses the catalogue you pass, else `CATALOGUE` (`catalogue.json`), else `catalogue.example.json`. It sends that
catalogue for real, so the products in it show up in your account.
The summary goes to stdout and log lines to stderr, so `node src/index.ts smoke > smoke.json` keeps the JSON clean.
It exits with 0 when every step worked and 1 otherwise; `errors` lists what failed.

## Configuration (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `CHARPSTAR_API_KEY` | yes | Your key, `cs_live_...`. Shown once when it is created; store it like a password. |
| `CHARPSTAR_API_BASE` | no | Where the API is (default `https://platform.charpstar.co`). |
| `WEBHOOK_SECRET` | for `listen` | `whsec_...`, shown once when the webhook subscription is created. |
| `WEBHOOK_PORT` | for `listen` | Local port of the receiver (default 8787). |
| `CATALOGUE` | no | Catalogue file, `.json` or `.csv` (default `catalogue.json`). |
| `OUT_DIR` | no | Where results are saved (default `out`). |
| `POLL_MINUTES` | no | Poll interval (default 5). |
| `RENDER_WAIT_MINUTES` | no | How long `render` waits for its jobs (default 15). |
| `WEBHOOK_HOST`, `WEBHOOK_PATH` | no | Bind address (default `127.0.0.1`) and path (default `/charpstar`). |
| `STATE_FILE` | no | Local memory of what was sent, the poll cursor and webhook ids (default `state.json`). |

## Your catalogue

JSON (a list, or `{"products": [...]}`), using the API's own field names:

```json
{
  "articleId": "CH-1001",
  "externalId": "erp-10001",
  "name": "Lounge Chair, blue",
  "category": "Chairs",
  "dimensionsCm": { "w": 72, "h": 81, "d": 78 },
  "variants": [{ "code": "BLUE", "colour": "Blue fabric" }],
  "images": ["https://cdn.example.com/ch-1001.jpg", "https://cdn.example.com/ch-1001-side.jpg"],
  "productLink": "https://shop.example.com/products/lounge-chair",
  "active": true
}
```

You can also set `subcategory`, `source3dUrl` (an https link to a CAD or 3D file you already have) and, on a
variant, its own `articleId`, `material` and `name`.

CSV (see `catalogue.example.csv`): columns `article_id,name,category,width_cm,height_cm,depth_cm,colours,images,product_link,active,external_id`.
Lists inside a cell are separated by `|`, and colours are `CODE:Name` (`BLUE:Blue fabric|GREY:Grey fabric`).

Rules the API enforces:
- **`articleId`** is your SKU or item number. It is the key everything joins on (the 3D file name and the embed's `data-articleid`). It must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so no spaces or slashes.
- **`images`** are reference photos for our 3D artists, as public **https URLs**, at most 10 per product. The client sends them as `referenceImages: [{"url": "..."}]`. The API does not take file uploads: if you list a local file, the client skips it and logs a warning. Put the photo on your CDN, DAM or shop first and list that URL.
- **`dimensionsCm`**: `w`, `h` and `d` in centimetres, each above 0 and below 10000. Out of range values are left out with a warning.
- **`category`** `"Furniture/Desks"` is split into category `Furniture` and subcategory `Desks` when you send no subcategory.
- **`active: false`** marks a product as discontinued. Nothing is deleted on our side.
- **`externalId`** is your system's own id, stored next to the article. If you leave it out, the client uses the article.

The API takes more product fields than this catalogue sends: `gtin`, `attributes` and `releaseAt`. The API reference
describes them.

## The API calls (with curl)

All calls send `Authorization: Bearer $CHARPSTAR_API_KEY`. Every answer carries an `X-Request-Id` header; quote it when you contact us.
Errors look like this:

```json
{ "error": { "code": "validation_failed", "message": "The product is not valid. See details.issues.", "details": { "issues": [{ "path": "name", "message": "Invalid input: expected string, received undefined" }] } } }
```

| HTTP | `error.code` | Meaning |
|---|---|---|
| 400 | `validation_failed` | The body, a field or a query value is invalid; `details.issues` says where. |
| 401 | `unauthorized` | The key is missing, wrong, revoked or expired. |
| 402 | `allowance_reached` | Your allowance for this kind of work is used up for the period; `details` has the numbers. |
| 403 | `forbidden` | `details.reason` is `client_not_enabled` or `missing_scope` (with `details.scope`). |
| 404 | `not_found` | Unknown article, order or job (or the API is switched off for your account). |
| 409 | `in_progress` | A parallel request is creating the same article. Send it again in a few seconds. |
| 409 | `not_ready` | The product is not in a state for this call yet, for example a job for a product without a delivered model. |
| 409 | `not_cancellable` | The job has started; only a queued job can be cancelled. |
| 409 | `idempotency_conflict` | The `Idempotency-Key` was used with a different body in the last 24 hours. |
| 413 | `too_large` | The body is over 4,000,000 bytes. Send fewer products per request. |
| 429 | `rate_limited` | Too many requests. Wait `Retry-After` seconds. |
| 500 | `internal_error` | Our side; `details.requestId` identifies it. |

**Check the key** (`GET /api/v1/me`)
```bash
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" https://platform.charpstar.co/api/v1/me
# {"client":{"id":"e2b7c1d4-...","name":"Your Company"},"keyPrefix":"cs_live_Ab3d","scopes":["products:read","products:write","assets:read","jobs:read","jobs:write"]}
```

**Send products** (`POST /api/v1/products`, scope `products:write`). Send one product or `{"products": [...]}` with up to 50 (this client sends 20 at a time).
```bash
curl -s -X POST https://platform.charpstar.co/api/v1/products \
  -H "Authorization: Bearer $CHARPSTAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"products":[{"articleId":"CH-1001","externalId":"erp-10001","source":"api","name":"Lounge Chair, blue","category":"Chairs","dimensionsCm":{"w":72,"h":81,"d":78},"variants":[],"referenceImages":[{"url":"https://cdn.example.com/ch-1001.jpg"}],"source3dUrl":null,"productLink":null,"active":true}]}'
# {"results":[{"articleId":"CH-1001","result":"created","status":"received","httpStatus":201}]}
```
Each product gets its own `result`:

| `result` | Meaning |
|---|---|
| `created` | New product; it is now in our production queue. |
| `updated` | Product details changed and were applied. |
| `unchanged` | Same as last time; nothing was written. Sending the same data twice is always safe. |
| `change_request` | Modelling has started, so a size or 3D source change was recorded for our team to review instead of applied. `pendingChanges` lists them (`field`, `from`, `to`, `requestedAt`). |
| `exists_delivered` | The 3D model is already delivered; nothing was changed. |
| `refused` | The product was refused; `error` has the `code` and `message` (for example `validation_failed`). |

A single product answers `201` when created and `200` otherwise. A batch answers `200` when every product was accepted,
`207` when the results are mixed (each item carries its own `httpStatus`), or the shared error status when every product
failed the same way. Some results also carry `statusDetail`, `variantsCreated`, `warnings` or `orderId`, the order the
product landed in (the client logs it as `order`).

**Read one article** (`GET /api/v1/assets/{article}`, scope `assets:read`)
```bash
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" https://platform.charpstar.co/api/v1/assets/CH-1001
```
```json
{
  "articleId": "CH-1001", "name": "Lounge Chair, blue", "status": "delivered",
  "deliveryDate": "2026-10-20", "updatedAt": "2026-10-20T09:30:00.000Z",
  "glbUrl": "https://cdn.charpstar.net/YourCompany/Android/CH-1001.glb",
  "usdzUrl": "https://cdn.charpstar.net/YourCompany/iOS/CH-1001.usdz", "usdzReady": true,
  "thumbnailUrl": "https://...", "viewerUrl": "https://platform.charpstar.co/agent-viewer?glb=...",
  "arUrl": "https://platform.charpstar.co/ar/...",
  "embed": { "dataClient": "YourCompany", "dataArticleId": "CH-1001", "snippet": "<script ...></script>\n<charpstar-viewer data-articleid=\"CH-1001\"></charpstar-viewer>" },
  "images": [
    { "id": "8d2f4c1a-packshot", "type": "packshot", "variant": "BLUE", "url": "https://...", "fileName": "CH-1001_packshot_front_1.png",
      "width": 2048, "height": 2048, "bytes": 412331, "createdAt": "2026-10-20T09:00:00.000Z", "approved": true, "primary": true, "jobId": null },
    { "id": "vid_...", "type": "video", "variant": null, "url": "https://.../turntable.mp4", "fileName": "CH-1001_video_360_1.mp4", "posterUrl": "https://...",
      "width": null, "height": null, "bytes": null, "createdAt": null, "approved": true, "primary": false, "jobId": null }
  ],
  "variations": [{ "articleId": "CH-1001-GREY", "status": "in_production", "thumbnailUrl": null, "glbUrl": null }]
}
```
Unknown article: `404` with `error.code` `not_found`. Before delivery the URL fields and `embed` are `null`.

`status` moves through `received` (we have it), `in_production`, `in_review`, `approved` and `delivered` (files are live).
A product that was cancelled has the status `cancelled`.
`usdzReady` can turn true a little after `delivered`; the iPhone AR file is made from the GLB.
Only images with `approved: true` are final, and `primary: true` marks the main packshot. Image `type` is one of
`packshot`, `thumbnail`, `scene`, `render`, `overlay`, `variation`, `video` or `edit`; videos also have a `posterUrl`.
`width`, `height`, `bytes` and `createdAt` can be `null` when we don't know them. `fileName` is the name from your
naming choice, and `jobId` is the job that made the image, or `null`.

**Read many articles** (`GET /api/v1/assets?articles=A,B,C`, up to 100)
```bash
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" "https://platform.charpstar.co/api/v1/assets?articles=CH-1001,CH-1002"
# {"client":{"id":"...","name":"Your Company"},"assets":[ ...same objects as above... ],"unknown":["CH-1002"],"nextCursor":null}
```

**What changed** (`GET /api/v1/assets?since=<ISO time>`)
```bash
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" "https://platform.charpstar.co/api/v1/assets?since=2026-10-20T09:00:00Z"
# {"client":{...},"assets":[...],"unknown":[],"nextCursor":"eyJ0Ijoi..."}
```
Articles changed after the time, oldest change first, 100 per page. While `nextCursor` is not `null`, ask again with the
same `since` plus `&cursor=<nextCursor>`. `since` is required; to get everything, pass `1970-01-01T00:00:00Z`.

**Limits.** 120 requests per minute per key, and 5,000 per day. Past either limit you get `429` with a `Retry-After`
header in seconds. This client waits that long and retries (up to 5 tries, also for `5xx`).

## Orders

An order is the batch of products that arrived together, through the API, an import or your CharpstAR account
(`source` is `api`, `import` or `platform`). Both calls need the scope `products:read`.

```bash
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" "https://platform.charpstar.co/api/v1/orders?status=in_production"
# {"orders":[{"id":"4d3c2b1a-...","status":"in_production","source":"api","createdAt":"2026-10-20T09:31:00.000Z",
#   "counts":{"received":0,"in_production":3,"in_review":1,"approved":0,"delivered":2,"cancelled":0}}],"nextCursor":null}
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" https://platform.charpstar.co/api/v1/orders/$ORDER_ID
# the same order, plus "items":[{"articleId":"CH-1001","status":"in_production","deliveryDate":"2026-11-20","pendingChanges":null}, ...]
```

- The list comes newest first, 100 per page. While `nextCursor` is not `null`, ask again with `cursor=<nextCursor>` added. `status` is optional.
- `counts` says how many items are in each status. The list has no items; the call with the id has them.
- The status of an order is worked out from its items: `delivered` when every item is delivered or cancelled, `in_review` when any item waits for you, `in_production` when any item is being made, else `received`.

`node src/index.ts orders` logs one `orders.order` line per order with `status`, `items` (the total) and `counts`.
`node src/index.ts orders <orderId>` logs the order, then one `order.item` line per item with its `status` and
`deliveryDate`. `push` logs the order id of each product it sent as `order`.

## Packshot jobs

A job makes pictures from a delivered model. Starting one needs the scope `jobs:write`; reading jobs and presets
needs `jobs:read`. The API also runs scene, edit, video and export jobs; this client starts packshots.

```bash
curl -s -X POST https://platform.charpstar.co/api/v1/jobs \
  -H "Authorization: Bearer $CHARPSTAR_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 0b9f6c1e-7d2a-4e5b-9c3d-1a2b3c4d5e6f" \
  -d '{"jobs":[{"type":"packshot","articleId":"CH-1001","options":{"preset":"Marketplace (GS1)"}},{"type":"packshot","articleId":"CH-1002"}]}'
# {"results":[{"id":"5c0e2f9a-...","type":"packshot","articleId":"CH-1001","status":"queued","httpStatus":202},
#   {"articleId":"CH-1002","type":"packshot","error":{"code":"not_ready","message":"CH-1002 has no delivered model yet; packshots are made from it."},"httpStatus":409}]}
curl -s -H "Authorization: Bearer $CHARPSTAR_API_KEY" https://platform.charpstar.co/api/v1/jobs/$JOB_ID
# {"id":"5c0e2f9a-...","status":"succeeded","outputs":[{"id":"c41f9a07-...","type":"packshot","view":"front","format":"png",
#   "fileName":"09521234567806_C1C0.png","url":"https://...","width":4096,"height":4096,"bytes":3210442}, ...],"error":null, ...}
```

- One request carries up to 50 jobs and answers `202` when every job started and `207` when the results are mixed. Each entry of `results` has its own `httpStatus`: read the entries.
- A product without a delivered model answers `409 not_ready`. An unknown article answers `404 not_found`.
- An `Idempotency-Key` makes the request safe to send again: the same key with the same body within 24 hours answers the first result and starts nothing twice.
- A job's `status` is `queued`, `running`, `succeeded`, `failed` or `cancelled`. `outputs` is filled once it has succeeded; `error` says why it failed.
- Save each output under its `fileName`. The name follows your naming choice. A new packshot of a view, made with the same preset, keeps the file name and gets a new `id`.
- A preset is a set of camera, lighting, background, size and format saved for your account. `GET /api/v1/presets?type=packshot` lists yours; name one in `options.preset`. Without options, a job makes a white, square 2048 px PNG of the front.
- `POST /api/v1/jobs/{jobId}/cancel` cancels a job while it is queued. `GET /api/v1/jobs` lists your jobs. `src/platform.ts` has a method for each.
- The pictures are also added to the product: they appear in the article's `images` with the job's id in `jobId`, and `asset.images.updated` is sent.

`node src/index.ts render CH-1001 CH-1002 --preset "Marketplace (GS1)"` does this:

1. With `--preset`, it checks the name against your presets and stops with the list of names when there is no such preset.
2. It starts one packshot job per article in one request, with a new `Idempotency-Key`.
3. It reports each article that was refused (`render.not_ready`, `render.refused`) and carries on with the others.
4. It reads each started job every 10 seconds until it has finished, for at most `RENDER_WAIT_MINUTES` (default 15). With more than 10 jobs waiting, the pause between rounds is one second per job, which keeps the reads inside the rate limit.
5. It saves the outputs of each succeeded job as `out/<article>/<fileName>` and logs `render.done` with the summary.

It exits with 0 when the pictures of every article were saved and 1 otherwise. A job that is still running when the
wait ends goes on; `pull <article>` fetches its pictures later, once they are approved images of the product.
With `listen` running, the `job.succeeded` event saves the same files.

## Webhooks

CharpstAR posts an event to your HTTPS URL when something changes. You subscribe your URL with
`POST /api/v1/webhooks` (scope `webhooks:manage`); the answer carries the signing secret (`whsec_...`) once.
Leave `events` out to receive every type.

```bash
curl -s -X POST https://platform.charpstar.co/api/v1/webhooks \
  -H "Authorization: Bearer $CHARPSTAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://your-host/charpstar","events":["asset.approved","asset.images.updated","status.changed","job.succeeded","job.failed"]}'
```

What arrives:

```
POST https://your-host/charpstar
Content-Type: application/json
User-Agent: CharpstAR-Webhooks/1
CharpstAR-Event: asset.approved
CharpstAR-Delivery: 6f1c2b9e-1d2c-4f7a-9a3b-5c6d7e8f9a0b
CharpstAR-Signature: t=1792000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

Every body has the same envelope; the article is in `article` (`null` when the event is about no single product):

```json
{ "id": "6f1c2b9e-...", "type": "asset.approved", "occurredAt": "2026-10-20T09:31:00.000Z",
  "client": { "id": "e2b7c1d4-...", "name": "Your Company" }, "article": "CH-1001", "data": { "...": "..." } }
```

| Event | When | `data` | This client |
|---|---|---|---|
| `product.received` | A new product is in our intake, sent by you or added by your CharpstAR team. | `articleId`, `name`, `category`, `subcategory`, `dimensionsCm`, `productLink`, `status`, `receivedAt` | logs it |
| `status.changed` | A product's status changed (for example `approved` to `delivered` when the 3D is live). | `from`, `to` | logs it; fetches and saves the article when `to` is `delivered` |
| `review.requested` | A model passed our quality check and waits for your approval. | `articleId`, `reviewUrl` | logs it |
| `asset.approved` | A model is approved. The event is held until the files are live, for up to 30 minutes. | the same object as `GET /api/v1/assets/{article}`; only `articleId` and `status` when the files were not live in time | fetches and saves the article |
| `asset.images.updated` | Images were added, replaced or removed (changes close together arrive as one event, about a minute later). | `added`, `removed` (image ids) | fetches and saves the article |
| `job.succeeded` | A job finished and its outputs are on the product. | the job, as in `GET /api/v1/jobs/{jobId}`, with `outputs` | saves each output as `out/<article>/<fileName>` |
| `job.failed` | A job could not finish. | the job, with `error` | logs the job and its error |
| `job.cancelled` | A job was cancelled, by you while it was queued or by our team. | the job | logs the job |
| `import.completed` | An import has processed every row. | the import: `id`, `status`, `rows`, `processed`, `counts`, `orderId` | logs the counts |
| `ping` | You asked for a test with `POST /api/v1/webhooks/{webhook_id}/test`. | `message` | answers 200 |

Any other event type is answered `200` and logged as `webhook.ignored`, so a type that is added later is never retried.
See `fixtures/events/` for one complete example of each event in the table.

**Verify every request** before you trust it (`src/webhook.ts`, `verifySignature`):
1. Read the **raw** body. Don't re-serialise parsed JSON.
2. From `CharpstAR-Signature`, take `t` and every `v1`.
3. Compute `HMAC-SHA256(WEBHOOK_SECRET, t + "." + rawBody)` as hex and compare it with the `v1` values in constant time.
4. Refuse the request if `t` is more than 5 minutes from your clock (replay protection).

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(v1)) && Math.abs(Date.now() / 1000 - t) <= 300;
```

**Answer correctly:**
- `2xx` within 10 seconds, once you have handled the event. This client answers `200` after saving the files.
- Anything else, or a timeout, is retried after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h (about 21 hours in total), and shows up for us as a failed delivery. Redirects are not followed. This client answers `503` when it couldn't fetch or save, so the retry comes.
- Retries carry the same `CharpstAR-Delivery` id and the same body. Remember handled ids and answer `200` to repeats (this client keeps the last 500 in `state.json`).
- Events can arrive more than once and out of order, so treat an asset event as "go and look". For those the client fetches the article fresh with `GET /api/v1/assets/{article}`. A finished job does not change, so for `job.succeeded` the client saves the outputs listed in the event itself.

**Getting HTTPS in front of the receiver.** `listen` serves plain HTTP on `127.0.0.1:8787`. Put any HTTPS reverse proxy
or tunnel in front of it (your load balancer, nginx or Caddy, a cloud tunnel) and register the public `https://.../charpstar` URL.
If you can't expose anything, use `poll`; it does the same work for products every few minutes.

## Polling mode

`poll` asks for `?since=<cursor minus 2 minutes>` and follows `nextCursor` until it is `null`. The cursor (in `state.json`)
is the newer of the server's clock when it answered (its `Date` header) and the newest `updatedAt` it has seen, so it
never depends on your clock. The first poll asks for everything. The 2 minute overlap covers changes that land while
a poll runs. Downloads are skipped when the file is already there, so seeing an article twice costs nothing. Downloads
that failed are retried on the next poll. Stop it with Ctrl+C; to run it permanently, use your scheduler (systemd,
launchd, Windows Task Scheduler, a container) or call `poll --once` from cron.

## What lands in `out/<article>/`

```
out/CH-1001/
  links.json         status, viewerUrl, arUrl, glbUrl, usdzUrl (once ready), thumbnailUrl, embedSnippet, variations
  images.json        the image list from the API + the local file of each approved image
  images/<id>.<ext>  every approved image or video, downloaded once
  primary.<ext>      a copy of the primary packshot
  <fileName>         every file a job made, under the name the API gave it (render, job.succeeded)
  outputs.json       one entry per job file: the output from the API + the id of the job that made it
```

To show the 3D viewer and AR button on your own product page, paste `embedSnippet`. It finds the model by
`data-articleid` = your article number. The documentation has a guide for the embed.

## Tests

The tests run against a mock platform on 127.0.0.1 with the fixtures in `fixtures/`, so they use no network and no key.
The program itself has no dependencies; the tests and the type-check use `vitest` and `typescript`:

```bash
npm install
npm test
npm run typecheck
```

The tests include a copy of the platform's webhook signer, so a signature change on either side shows up as a failing test.
The fixtures for orders, presets, jobs and their events are built from the examples of the API reference.

## Licence

MIT. See `LICENSE`.
