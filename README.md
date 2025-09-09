# GitHub Multi-Repo Monthly Stats

A Node.js script that aggregates monthly GitHub statistics across multiple repositories using the GitHub GraphQL API v4.

## Features

- **Multi-repository support**: Analyze stats across multiple repositories in a single run
- **Comprehensive metrics**: Tracks PRs, issues, commits, reviews, and comments
- **Fair attribution**: Credits contributors based on their actual contributions
- **Bot filtering**: Automatically excludes bot accounts from statistics
- **Multiple output formats**: Generates CSV, JSON, and Markdown reports
- **Rate limit handling**: Built-in pagination and rate limit management

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Configure your `.env` file:
   ```env
   # GitHub Personal Access Token with repo (private) or public_repo (public only) scope
   GITHUB_TOKEN=ghp_your_token_here

   # Comma-separated list of repositories in owner/name format
   REPOS=owner1/repo1,owner2/repo2,owner3/repo3

   # Target month in YYYY-MM format (UTC window)
   MONTH=2024-01

   # Optional: prefix for output files (default: github-stats)
   OUTPUT_BASENAME=github-stats
   ```

### GitHub Token Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate a new token with the following scopes:
   - `repo` (for private repositories) or `public_repo` (for public repositories only)
   - `read:org` (if analyzing organization repositories)

## Usage

Run the script:
```bash
npm start
# or
node index.js
```

## Output Files

The script generates four output files organized in a `reports/YYYY-MM/` folder structure:

**Note:** The `reports/` folder is automatically added to `.gitignore` to keep generated reports out of version control.

### 1. CSV File (`reports/{MONTH}/{OUTPUT_BASENAME}-{MONTH}.csv`)
Contains per-contributor statistics with the following columns:
- `login`: GitHub username
- `merged_prs`: Number of merged pull requests
- `reviews`: Number of reviews submitted
- `commits`: Number of commits to default branch
- `issues_closed`: Number of issues closed
- `pr_comments`: Number of PR comments
- `issue_comments`: Number of issue comments
- `additions`: Total lines added
- `deletions`: Total lines deleted

### 2. JSON File (`reports/{MONTH}/{OUTPUT_BASENAME}-{MONTH}.json`)
Contains the same contributor data plus metadata:
```json
{
  "month": "2024-01",
  "fromISO": "2024-01-01T00:00:00.000Z",
  "toISO": "2024-02-01T00:00:00.000Z",
  "generatedAt": "2024-01-15T10:30:00.000Z",
  "contributors": [...]
}
```

### 3. Markdown Report (`reports/{MONTH}/report.md`)
Contains:
- Repository statistics table
- Contributor count
- Top PR authors, reviewers, and commenters

### 4. Enhanced Markdown Report (`reports/{MONTH}/{OUTPUT_BASENAME}-{MONTH}-enhanced.md`)
Contains:
- Repository overview table
- Per-repository contributor breakdown
- Detailed contributor statistics by repository

## Metrics Explained

### Repository-Level Metrics
- **Merged PRs**: Count of PRs merged within the time window
- **Open PRs**: Count of PRs opened within the time window that are still open
- **Closed Issues**: Count of issues closed within the time window
- **New Issues**: Count of issues created within the time window

### Contributor Attribution
- **PRs merged** → Credit to PR author
- **Reviews** → Credit to review author for each review submitted
- **Commits** → Credit to commit author for commits to default branch
- **Issues closed** → Credit to PR author (if auto-closed) or issue closer
- **PR comments** → Credit to comment author
- **Issue comments** → Credit to comment author

## Bot Filtering

The script automatically excludes:
- Accounts with `[bot]` suffix
- Accounts containing "bot" in the username
- Hard-coded list of known service accounts (Dependabot, Renovate, etc.)

## Rate Limiting

The script includes built-in rate limit handling:
- Automatic pagination (100 items per page)
- Retry logic for 429 (rate limit) responses
- Sequential processing to avoid overwhelming the API

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- Valid GitHub Personal Access Token
- Internet connection for API access

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check your GitHub token and ensure it has the correct scopes
2. **403 Forbidden**: Repository may be private and your token lacks access
3. **Rate limit exceeded**: The script will automatically retry, but you may need to wait
4. **Repository not found**: Verify the repository names are in `owner/name` format

### Debug Mode

For debugging, you can add console.log statements or use Node.js debugging tools:
```bash
node --inspect index.js
```

## Example Output

### CSV Sample
```csv
login,merged_prs,reviews,commits,issues_closed,pr_comments,issue_comments,additions,deletions
john-doe,5,12,8,3,15,7,1250,340
jane-smith,3,8,15,2,22,12,890,210
```

### Markdown Report Sample
```markdown
## Github stats (JANUARY 2024)

| Github Repo | Merged PRs | Open PRs | Closed Issues | New Issues |
|---|---:|---:|---:|---:|
| [owner/repo1](https://github.com/owner/repo1) | 5 | 6 | 5 | 4 |
| [owner/repo2](https://github.com/owner/repo2) | 2 | 4 | 4 | 2 |
| **Total** | **7** | **10** | **9** | **6** |

Thanks to everyone who contributed this month — we saw a lot of activity and new contributors.

- **8 contributors** contributed to these repositories.
- **Top PR authors:** @john-doe, @jane-smith, @alice-wonder
- **Top reviewers:** @reviewer1, @reviewer2, @reviewer3
- **Top commenters:** @commenter1, @commenter2, @commenter3
```

## License

This project is open source and available under the MIT License.
