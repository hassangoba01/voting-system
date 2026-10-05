# Student Voting System

A local voting system with two interfaces:

- **Voters:** http://localhost:3000/
- **Admin:** http://localhost:3000/admin (username `admin`, password `admin1234`)

## Setup in VS Code

1. Install **Node.js 18 or newer** from https://nodejs.org (the LTS version is fine).
2. In VS Code choose **File > Open Folder** and open this `voting-system` folder.
3. Open the terminal (**Terminal > New Terminal**) and run:

   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000/admin in your browser.

To stop the server press `Ctrl + C` in the terminal.

## First-time workflow

1. Sign in to the admin panel.
2. **Positions:** add each position (President, Secretary, ...).
3. **Candidates:** add candidates with their photo and position.
4. **Voters:** upload an Excel file (`.xlsx`). See `sample-voters.xlsx`. The first row must have the columns `name` and `id`.
5. On the **Results** page click **Open voting**.
6. Voters go to http://localhost:3000/, enter their student ID and vote.
7. Watch live results on the Results page. Click **Close voting** when done, then **Export results** for the PDF.

## Rules built in

- Voting starts **closed**.
- Each student ID can vote once. IDs ignore spaces and letter case.
- Voters must pick one candidate for every position that has an active candidate.
- Votes are anonymous: the `voters` table only stores whether someone voted, and the `votes` table has no voter ID and no timestamp.
- A voter's votes are saved in one database transaction.
- Suspending a candidate removes their votes from the results. Reinstating restores them (the votes are kept in the database).
- While voting is open, positions and candidates can't be added, edited or deleted. Suspend and reinstate still work.
- Ties are shown as ties. There is no automatic tiebreak.
- Voters never see results.

## Changing settings

Locally, edit `config.js`. When deployed, set these as Railway **Variables** instead (they override `config.js`):

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Admin password (required on Railway) |
| `SESSION_SECRET` | Any long random text (required on Railway) |
| `ADMIN_USERNAME` | Optional, defaults to `admin` |
| `ELECTION_NAME` | Optional, shown in the page header and PDF |

## Deploying to Railway

See the steps in the chat. In short: push this folder to GitHub, create a Railway project from the repo, add the variables above, attach a **Volume** mounted at `/data`, and generate a domain. The Volume is essential: without it the database and photos are wiped on every redeploy. Keep the service at **one replica** (SQLite is a single file).

## Where data lives

- `data/voting.db`: the database (delete this file to start over)
- `uploads/`: candidate photos

## Troubleshooting

- **`npm install` fails on `better-sqlite3`:** use the current LTS Node.js release. On Windows, if it still fails, install the "Desktop development with C++" build tools from the Visual Studio Installer and run `npm install` again.
- **Port 3000 is in use:** change `PORT` in `config.js`.
- **Upload says columns are missing:** make sure row 1 of the sheet has headers named `name` and `id`.
