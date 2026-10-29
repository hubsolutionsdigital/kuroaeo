# SEO & AEO Client Review Portal

A review portal for SEO/AEO client work. The team uploads Excel sheets and blog documents for each client project. Each client opens **one private link per project**. Clients need no login or email. They review the work across five tabs:

| Tab | What goes in it |
| --- | --- |
| 🔑 Keywords | Keyword lists and monthly ranking reports, with Top 3 / Top 10 / Top 30 / Top 100 counts and month-on-month movement |
| 📄 On-Page SEO | Page titles, meta descriptions, H1s and recommendations |
| 🔗 Backlinks | Backlink opportunities |
| 💬 Prompts | AI search prompts (AEO) |
| ✍️ Blogs | Blog articles from Word documents, plus article plans from Excel |
| ✨ AI rankings | Columns in the keyword sheet such as *AI Overview (Month 4)*, *AI Mode*, *ChatGPT*, *Gemini*, *Perplexity* or *Copilot* (1 = named first, Yes = shown, blank/No = not shown) appear on Performance as AI tiles and table columns |
| 📍 GBP Posts | Google Business Profile posts from Word documents (“POST 1 · title”, image, copy, CTA and landing page) |

For any row in a sheet, a client can choose one of these:
❤️ **Love it** · 👍 **Like this** · 🎉 **This is great** · ✅ **Approve** · ✏️ **Suggest a change** · ❓ **Ask a question**.
The client adds their name and an optional comment. Their name is remembered in their browser. The team answers from the admin dashboard, and replies show up on the client's link.

When a client presses **📨 Submit feedback** (or finishes a whole section), they see a thank-you message and the team gets **one summary email** for that round, e.g. *“Dorothy submitted feedback · Dot Chambers (12 comments)”*, listing every approval, comment, question and text edit with a link to the Feedback tab. If the client never presses Submit, the summary is sent 10 minutes after their last comment.

For publishing, **⬇ Word** (Admin → Content, beside each blog, GBP or landing page document, and per article on the Feedback tab) downloads a .docx with the client’s text edits applied, each article’s approval status, its SEO or post details, images, links and tables, and any requests from the client that are still open.

Blogs, GBP posts and landing pages work like a Word document: the client clicks any paragraph, heading, list item or table cell and edits the words directly. Edits save automatically under their name, added words are highlighted and removed words struck through, and each edit can be undone. The team sees every edit as a before-and-after on the Feedback tab (and in the CSV export), and copies the new wording into the next version of the document. Clients approve each article, or leave a comment or question.

## Run it

Requires Node.js 22.13 or newer. It uses the built-in SQLite, so there is no database to install.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
# → http://localhost:3000/admin
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin` (refused when `NODE_ENV=production`) | Team login for `/admin` |
| `AGENCY_NAME` | `Hub Solutions Digital` | Shown on the client portal and on team replies |
| `DATA_DIR` | `./data` | Where the SQLite database lives. Keep it on a persistent disk |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | derived from the password | Signs the admin login cookie |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | OAuth web client for "Connect Google account" (GA4 and Search Console) |
| `GOOGLE_REDIRECT_URI` | `<this site>/api/admin/google/callback` | Only if the portal sits behind a proxy that changes the host |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | Alternative to the above: a service account key (the whole JSON, or base64 of it) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | port `465` | Mailbox that sends feedback alerts (Zoho Mail: `smtp.zoho.com`, port 465, an app password) |
| `ALERT_EMAIL` | — | Who gets feedback alerts (comma-separated). Each project can override this in Settings |
| `ALERT_FROM`, `PUBLIC_URL` | `SMTP_USER`, the admin's address | Sender address, and the portal address used for links in alert emails |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | — | Optional: weekly or daily live Google checks per keyword: Google AI Overview (named, and in which place) and the exact position (about US$0.006 per keyword check, top 20 results) |
| `SEMRUSH_API_KEY` | — | Optional: daily live rankings from SEMrush |

Docker: `docker build -t review-portal . && docker run -p 3000:3000 -e ADMIN_PASSWORD=… -v portal-data:/data review-portal`.

### Railway

1. **New Project → Deploy from GitHub repo** and pick this repo. `railway.json` tells Railway to build the Dockerfile and check `/healthz`.
2. **Add a volume** to the service with mount path `/data`. Without it, projects and feedback are lost on every redeploy.
3. **Variables:** set `ADMIN_PASSWORD` (required) and optionally `AGENCY_NAME`. Railway sets `PORT` itself.
4. **Settings → Networking → Generate Domain**, or add your own custom domain. Client links use whichever address you open the admin from.

Tests: `npm test`.

## Workflow

1. **Admin → New project.** Copy the client link from the project page and send it to the client.
2. **Upload → Excel workbook (.xlsx).** Every sheet is detected. Choose which tab each sheet goes to, the name the client sees, and the report month. The tab is pre-filled from the sheet name: *Keywords / Projected Rankings* → Keywords, *On-Page* → On-Page SEO, *Backlinks*, *Prompts*, *Articles* → Blogs. *Tasks* and empty sheets are skipped.
   - Columns are kept exactly as in your sheet. Fully empty columns are hidden, except ranking columns.
   - Title rows above the header (e.g. "MindRight Keyword Proposal") are detected and shown as a subtitle.
   - Ranking columns (`Actual Ranking (Month N)`, `Existing Ranking`, `Rank`, `Position`) are shown as coloured badges. The latest month is compared with the previous one. Projection columns (`Phase …`, `Month 6`…) are shown as dashed ranges. If Excel turned a range like "5-12" into a date, it is turned back into "5-12".
3. **Monthly rankings.** Each month, upload the updated sheet under the **same name**. It becomes a new report month: the client sees the latest month first and can switch to earlier ones. Feedback on a keyword stays attached to that keyword across months.
4. **Upload → Blog articles (.docx).** This uses the same format as *Blog Articles for Review*:
   - each `Article 1: …` / `Article 2: …` heading becomes its own article;
   - the `SEO details` table becomes an SEO card (focus keyword, slug, meta title, meta description and so on);
   - `☐` items under *For your review* become points the client confirms one by one;
   - images and highlighted keywords are kept.
   Clients can approve each article, give overall feedback, or highlight any sentence to comment on that part.
5. **Feedback tab.** *Needs answer* lists open change requests and questions. Reply (this resolves the item), mark as resolved, or export everything to CSV. If a client follows up on a resolved item, it reopens.

## Access model

- Client links are unguessable random tokens (`/p/<token>`). Pages are served with `noindex` and `no-referrer`. If a link was shared too widely, go to **Settings → Create a new link**. The old link stops working immediately.
- Clients can only read their own project and add feedback. All admin routes require the team password.

## Performance dashboard

Clients switch between **✅ Review** and **📈 Performance**. The Performance view shows growth tiles, a plain-English summary and monthly charts:

- **Google Search Console:** clicks and impressions, plus each tracked keyword's average position and clicks over the last 28 days.
- **Google Analytics 4:** organic sessions, key events (enquiries, bookings) and revenue, plus visits referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot…).
- **Ranking reports:** keywords in the top 3, 4–10, 11–30 and 31–100 each month, and keywords appearing in AI answers. These come from the uploaded sheets.
- **Uploaded numbers:** any monthly business figures from Excel (a `Month` column plus one column per number), or a Search Console "Dates" export.
- **SEMrush (optional):** today's position for each keyword. It only appears when the admin enables it for the project and allows the client toggle. The client's "Live rankings" switch starts off.

### Connecting Google (one time)

The portal signs in as one agency Google account (no key file needed, so it works when your organisation blocks service account keys).

1. In Google Cloud → **APIs & Services → Library**, enable the **Google Analytics Data API**, **Google Search Console API**, **Google Analytics Admin API** (lists properties for the picker) and **Google Drive API** (lets you pick a Google Sheet instead of uploading an .xlsx: on the Upload tab for keyword and ranking sheets, and under Monthly numbers).
2. **OAuth consent screen** (Google Auth Platform): audience **Internal**, so only your Workspace accounts can sign in and the connection does not expire after 7 days.
3. **Clients → Create client → Web application**, with the authorised redirect URI shown in **Admin → project → Performance** (`https://<your domain>/api/admin/google/callback`).
4. In Railway → Variables, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. After the redeploy, click **Connect Google account** in Admin → Performance and sign in with the account that has access to your clients' GA4 and Search Console. The refresh token is stored encrypted with `SESSION_SECRET` (or the admin password); changing either means connecting again.
5. If a client's property is missing from the list, ask the client to add that account as a **Viewer** in GA4 and a user in Search Console.

A service account (`GOOGLE_SERVICE_ACCOUNT_JSON`) still works instead, if you prefer one.

6. Enter the GA4 property ID and the Search Console property (`sc-domain:example.com` or `https://www.example.com/`), set the campaign start month, then click **Sync Google now**. After that, data refreshes daily.
