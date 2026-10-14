# SEO & AEO Client Review Portal

A review portal for SEO/AEO client work. The team uploads Excel sheets and blog documents for each client project. Each client opens **one private link per project**. Clients need no login or email. They review the work across five tabs:

| Tab | What goes in it |
| --- | --- |
| 🔑 Keywords | Keyword lists and monthly ranking reports, with Top 3 / Top 10 / Top 30 / Top 100 counts and month-on-month movement |
| 📄 On-Page SEO | Page titles, meta descriptions, H1s and recommendations |
| 🔗 Backlinks | Backlink opportunities |
| 💬 Prompts | AI search prompts (AEO) |
| ✍️ Blogs | Blog articles from Word documents, plus article plans from Excel |

For any row, article, or highlighted passage of text, a client can choose one of these:
❤️ **Love it** · 👍 **Like this** · 🎉 **This is great** · ✅ **Approve** · ✏️ **Suggest a change** · ❓ **Ask a question**.
The client adds their name and an optional comment. Their name is remembered in their browser. The team answers from the admin dashboard, and replies show up on the client's link.

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
