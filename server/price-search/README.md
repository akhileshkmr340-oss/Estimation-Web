# Live price search (Google results and ChatGPT search)

A small Cloudflare Worker (`worker.js`) that the website calls when you press
**Search prices online** in an item's edit box. It checks that you are logged
in to the website, asks Google results (through Serper) and ChatGPT web search
for current Indian prices, and sends back only prices seen on a page, each
with its link. It stores nothing.

## What it costs

- Cloudflare Workers: free (100,000 requests a day).
- Serper (Google results): 2,500 free searches when you sign up, then about
  US$1 per 1,000 searches. One item search uses 2 searches.
- OpenAI (ChatGPT search): about US$10 to 25 per 1,000 searches plus the model
  fee. Set a monthly budget limit in your OpenAI account.

You can set up only one of the two; the button then uses the one you have.

## Set it up (about 15 minutes, all in the browser)

Keep every key to yourself. Paste keys only into Cloudflare, never into chat.

1. **Serper key.** Open https://serper.dev, click **Sign up**, sign in with
   Google. On the dashboard, open **API Key** and click **Copy**.
2. **OpenAI key** (optional). Open https://platform.openai.com, sign in, open
   **Settings > Billing**, add credit and set a monthly limit. Then open
   **API keys > Create new secret key**, name it `estimation`, **Create**, and
   **Copy**.
3. **Cloudflare account.** Open https://dash.cloudflare.com/sign-up and create a
   free account (verify the email).
4. **Create the Worker.** In the left menu click **Compute (Workers) > Workers &
   Pages > Create > Create Worker** (or **Start with Hello World!**). Name it
   `estimation-price-search` and click **Deploy**.
5. **Paste the code.** Click **Edit code**. Delete everything in `worker.js`
   on the left, open
   https://raw.githubusercontent.com/akhileshkmr340-oss/Estimation-Web/main/server/price-search/worker.js,
   select all, copy, paste it in, and click **Deploy** (top right).
6. **Add the keys.** Go back to the Worker, open **Settings > Variables and
   Secrets > Add**. Add each of these with type **Secret**, then **Deploy**:
   - `FIREBASE_API_KEY` = `AIzaSyDn181WEUUq6Dw9F0-2OgXzm0vbe6cfLkI` (the
     website's public Firebase key; not a secret, it only lets the Worker
     check logins)
   - `SERPER_API_KEY` = the Serper key from step 1
   - `OPENAI_API_KEY` = the OpenAI key from step 2 (skip if you have none)
7. **Copy the Worker address** shown at the top of the Worker page, like
   `https://estimation-price-search.yourname.workers.dev`, and send that
   address (only the address) to Claude in the project chat. Claude adds it
   to the website as `priceSearch` in `accounts-config.js` and deploys.

To check it: open the Worker address in a browser. It shows
`{"ok":true,"google":true,"chatgpt":true}` for the keys it has.

## Options

- `OPENAI_MODEL` (plain variable): the ChatGPT model, default `gpt-5-mini`.
- `ALLOWED_ORIGINS` (plain variable): websites allowed to call it, default
  `https://akhileshkmr340-oss.github.io`.

## How the website uses a price

The price you pick goes in as your supply rate for that item, with its brand,
the source (search, seller and the price seen) and the link on the Rates sheet.
Marketplace prices in India usually include GST, so the box takes 18% out
unless you switch that off or the page said the price is before GST.

## Test

`node test/worker_test.mjs` runs the Worker against stubbed Firebase, Serper
and OpenAI answers.
