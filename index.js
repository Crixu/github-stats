import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Load environment variables
dotenv.config();

// Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPOS = process.env.REPOS?.split(',').map(repo => repo.trim()) || [];
const MONTH = process.env.MONTH;
const OUTPUT_BASENAME = process.env.OUTPUT_BASENAME || 'github-stats';

// Validate required environment variables
if (!GITHUB_TOKEN) {
	console.error('Error: GITHUB_TOKEN is required');
	process.exit(1);
}

if (!REPOS.length) {
	console.error('Error: REPOS is required (comma-separated list)');
	process.exit(1);
}

if (!MONTH) {
	console.error('Error: MONTH is required (YYYY-MM format)');
	process.exit(1);
}

// Parse month and create date range
const [year, month] = MONTH.split('-').map(Number);
const fromISO = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
const toISO = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();

console.log(`Collecting stats for ${MONTH} (${fromISO} to ${toISO})`);
console.log(`Repositories: ${REPOS.join(', ')}`);

// Bot detection
const isBot = (login) => {
	if (!login) return true;
	return login.endsWith('[bot]') || login.includes('bot');
};

// Hard-coded bot deny list
const BOT_DENY_LIST = [
	'dependabot[bot]',
	'renovate[bot]',
	'github-actions[bot]',
	'codecov[bot]',
	'greenkeeper[bot]',
	'mergify[bot]',
	'stale[bot]',
	'cla-bot[bot]',
	'cla-assistant[bot]',
	'homu[bot]',
	'bors[bot]',
	'rust-highfive[bot]',
	'rust-log-analyzer[bot]',
	'rust-timer[bot]',
	'rust-lang[bot]',
	'rust-lang-deprecated[bot]',
	'rust-lang-nursery[bot]',
	'rust-lang-tools[bot]',
	'rust-lang-wg[bot]',
	'rust-lang-wg-nursery[bot]',
	'rust-lang-wg-tools[bot]',
	'rust-lang-wg-unsafe-code-guidelines[bot]',
	'rust-lang-wg-unsafe-code-guidelines-nursery[bot]',
	'rust-lang-wg-unsafe-code-guidelines-tools[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines-nursery[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines-tools[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines-unsafe-code-guidelines[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines-unsafe-code-guidelines-nursery[bot]',
	'rust-lang-wg-unsafe-code-guidelines-unsafe-code-guidelines-unsafe-code-guidelines-tools[bot]'
];

const isBotDenied = (login) => {
	return isBot(login) || BOT_DENY_LIST.includes(login);
};

// GitHub GraphQL client
class GitHubClient {
	constructor(token) {
		this.token = token;
		this.baseURL = 'https://api.github.com/graphql';
	}

	async query(query, variables = {}) {
		const response = await fetch(this.baseURL, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			if (response.status === 429) {
				const retryAfter = response.headers.get('Retry-After');
				console.log(`Rate limited. Waiting ${retryAfter || 60} seconds...`);
				await new Promise(resolve => setTimeout(resolve, (retryAfter || 60) * 1000));
				return this.query(query, variables);
			}
			throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		if (data.errors) {
			throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
		}

		return data.data;
	}

	async paginate(query, variables = {}, pageSize = 100, extractPath = '') {
		const results = [];
		let hasNextPage = true;
		let cursor = null;

		// Check if query already has $after variable
		const hasAfterVariable = query.includes('$after: String');
		
		// Create the paginated query once
		let paginatedQuery;
		if (hasAfterVariable) {
			// Query already has $after variable, just use it as-is
			paginatedQuery = query;
		} else {
			// Add $after variable and parameter
			paginatedQuery = query.replace(
				'$first: Int!',
				`$first: Int!, $after: String`
			).replace(
				'first: $first',
				'first: $first, after: $after'
			);
		}

		while (hasNextPage) {
			const paginatedVariables = {
				...variables,
				first: pageSize,
				after: cursor,
			};

			const data = await this.query(paginatedQuery, paginatedVariables);
			const edges = this.extractEdgesFromPath(data, extractPath);
			
			results.push(...edges.map(edge => edge.node));
			
			hasNextPage = edges.length > 0 && edges[edges.length - 1].cursor;
			if (hasNextPage) {
				cursor = edges[edges.length - 1].cursor;
			}
		}

		return results;
	}

	extractEdgesFromPath(data, path) {
		// Navigate to the specific path in the data structure
		const pathParts = path.split('.');
		let current = data;
		
		for (const part of pathParts) {
			if (current && current[part]) {
				current = current[part];
			} else {
				return [];
			}
		}
		
		return current?.edges || [];
	}
}

// Repository stats collector
class RepoStatsCollector extends GitHubClient {
	constructor(token) {
		super(token);
		this.contributorStats = new Map();
		this.repoContributorStats = new Map(); // repo -> contributor stats
		this.repoStats = [];
	}

	async collectStats(repos, fromISO, toISO) {
		console.log(`\nCollecting stats for ${repos.length} repositories...`);
		
		for (const repo of repos) {
			console.log(`\nProcessing ${repo}...`);
			await this.collectRepoStats(repo, fromISO, toISO);
		}

		return {
			contributorStats: this.contributorStats,
			repoContributorStats: this.repoContributorStats,
			repoStats: this.repoStats,
		};
	}

	async collectRepoStats(repo, fromISO, toISO) {
		const [owner, name] = repo.split('/');
		
		// Get repository info and default branch
		const repoQuery = `
			query($owner: String!, $name: String!) {
				repository(owner: $owner, name: $name) {
					name
					url
					defaultBranchRef {
						name
					}
				}
			}
		`;

		const repoData = await this.query(repoQuery, { owner, name });
		if (!repoData.repository) {
			console.log(`Repository ${repo} not found or not accessible`);
			return;
		}

		const defaultBranch = repoData.repository.defaultBranchRef?.name || 'main';
		console.log(`  Default branch: ${defaultBranch}`);

		// Initialize repo stats
		const repoStat = {
			name: repo,
			url: repoData.repository.url,
			mergedPRs: 0,
			openPRs: 0,
			closedIssues: 0,
			newIssues: 0,
		};

		// Collect merged PRs
		console.log(`  Collecting merged PRs...`);
		await this.collectMergedPRs(owner, name, fromISO, toISO, repo);

		// Collect open PRs (opened in window, still open)
		console.log(`  Collecting open PRs...`);
		await this.collectOpenPRs(owner, name, fromISO, toISO, repo);

		// Collect closed issues
		console.log(`  Collecting closed issues...`);
		await this.collectClosedIssues(owner, name, fromISO, toISO, repo);

		// Collect new issues
		console.log(`  Collecting new issues...`);
		await this.collectNewIssues(owner, name, fromISO, toISO, repo);

		// Collect commits
		console.log(`  Collecting commits...`);
		await this.collectCommits(owner, name, defaultBranch, fromISO, toISO, repo);

		// Collect PR comments
		console.log(`  Collecting PR comments...`);
		await this.collectPRComments(owner, name, fromISO, toISO, repo);

		// Collect issue comments
		console.log(`  Collecting issue comments...`);
		await this.collectIssueComments(owner, name, fromISO, toISO, repo);

		// Update repo stats with actual counts
		repoStat.mergedPRs = this.getMergedPRCount(owner, name);
		repoStat.openPRs = this.getOpenPRCount(owner, name);
		repoStat.closedIssues = this.getClosedIssueCount(owner, name);
		repoStat.newIssues = this.getNewIssueCount(owner, name);

		this.repoStats.push(repoStat);
		console.log(`  Completed ${repo}: ${repoStat.mergedPRs} merged PRs, ${repoStat.openPRs} open PRs, ${repoStat.closedIssues} closed issues, ${repoStat.newIssues} new issues`);
	}

	async collectMergedPRs(owner, name, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					pullRequests(first: $first, after: $after, states: [MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								title
								author {
									login
								}
								mergedAt
								additions
								deletions
								reviews(first: 100) {
									edges {
										node {
											author {
												login
											}
											state
											submittedAt
										}
									}
								}
								closingIssuesReferences(first: 100) {
									edges {
										node {
											number
											author {
												login
											}
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		const prs = await this.paginate(query, { owner, name }, 50, 'repository.pullRequests');
		
		for (const pr of prs) {
			if (pr.mergedAt && pr.mergedAt >= fromISO && pr.mergedAt < toISO) {
				// Count as merged PR
				this.incrementRepoStat(owner, name, 'mergedPRs');
				
				// Credit PR author
				if (pr.author && !isBotDenied(pr.author.login)) {
					this.addContributorStat(pr.author.login, 'merged_prs', 1, repo);
					this.addContributorStat(pr.author.login, 'additions', pr.additions || 0, repo);
					this.addContributorStat(pr.author.login, 'deletions', pr.deletions || 0, repo);
				}

				// Credit reviewers
				if (pr.reviews) {
					for (const review of pr.reviews.edges) {
						const reviewNode = review.node;
						if (reviewNode.author && !isBotDenied(reviewNode.author.login) && 
							reviewNode.submittedAt && reviewNode.submittedAt >= fromISO && reviewNode.submittedAt < toISO) {
							this.addContributorStat(reviewNode.author.login, 'reviews', 1, repo);
						}
					}
				}

				// Credit issue closers (PR author gets credit for auto-closed issues)
				if (pr.closingIssuesReferences) {
					for (const issueRef of pr.closingIssuesReferences.edges) {
						const issue = issueRef.node;
						if (issue.author && !isBotDenied(issue.author.login)) {
							this.addContributorStat(pr.author?.login || 'unknown', 'issues_closed', 1, repo);
						}
					}
				}
			}
		}
	}

	async collectOpenPRs(owner, name, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					pullRequests(first: $first, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								title
								author {
									login
								}
								createdAt
								state
							}
						}
					}
				}
			}
		`;

		const prs = await this.paginate(query, { owner, name }, 50, 'repository.pullRequests');
		
		for (const pr of prs) {
			if (pr.createdAt && pr.createdAt >= fromISO && pr.createdAt < toISO && pr.state === 'OPEN') {
				// Count as open PR (opened in window, still open)
				this.incrementRepoStat(owner, name, 'openPRs');
			}
		}
	}

	async collectClosedIssues(owner, name, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					issues(first: $first, after: $after, states: [CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								title
								author {
									login
								}
								closedAt
								assignees(first: 10) {
									edges {
										node {
											login
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		const issues = await this.paginate(query, { owner, name }, 50, 'repository.issues');
		
		for (const issue of issues) {
			if (issue.closedAt && issue.closedAt >= fromISO && issue.closedAt < toISO) {
				this.incrementRepoStat(owner, name, 'closedIssues');
				
				// Credit issue closer (or first assignee if no closer)
				if (issue.author && !isBotDenied(issue.author.login)) {
					this.addContributorStat(issue.author.login, 'issues_closed', 1, repo);
				} else if (issue.assignees && issue.assignees.edges.length > 0) {
					const firstAssignee = issue.assignees.edges[0].node;
					if (!isBotDenied(firstAssignee.login)) {
						this.addContributorStat(firstAssignee.login, 'issues_closed', 1, repo);
					}
				}
			}
		}
	}

	async collectNewIssues(owner, name, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					issues(first: $first, after: $after, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								title
								author {
									login
								}
								createdAt
							}
						}
					}
				}
			}
		`;

		const issues = await this.paginate(query, { owner, name }, 50, 'repository.issues');
		
		for (const issue of issues) {
			if (issue.createdAt && issue.createdAt >= fromISO && issue.createdAt < toISO) {
				this.incrementRepoStat(owner, name, 'newIssues');
			}
		}
	}

	async collectCommits(owner, name, defaultBranch, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $branch: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					ref(qualifiedName: $branch) {
						target {
							... on Commit {
								history(first: $first, after: $after, since: "${fromISO}", until: "${toISO}") {
									edges {
										cursor
										node {
											author {
												user {
													login
												}
											}
											committedDate
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		const commits = await this.paginate(query, { owner, name, branch: defaultBranch }, 50, 'repository.ref.target.history');
		
		for (const commit of commits) {
			if (commit.author && commit.author.user && !isBotDenied(commit.author.user.login)) {
				this.addContributorStat(commit.author.user.login, 'commits', 1, repo);
			}
		}
	}

	async collectPRComments(owner, name, fromISO, toISO, repo) {
		// First get PRs with minimal data to avoid node limit
		const prQuery = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					pullRequests(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								comments(first: 10) {
									edges {
										node {
											author {
												login
											}
											createdAt
										}
									}
								}
								reviewThreads(first: 10) {
									edges {
										node {
											comments(first: 10) {
												edges {
													node {
														author {
															login
														}
														createdAt
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		const prs = await this.paginate(prQuery, { owner, name }, 50, 'repository.pullRequests');
		
		for (const pr of prs) {
			// PR discussion comments
			if (pr.comments) {
				for (const comment of pr.comments.edges) {
					const commentNode = comment.node;
					if (commentNode.author && !isBotDenied(commentNode.author.login) &&
						commentNode.createdAt && commentNode.createdAt >= fromISO && commentNode.createdAt < toISO) {
						this.addContributorStat(commentNode.author.login, 'pr_comments', 1, repo);
					}
				}
			}

			// PR review comments
			if (pr.reviewThreads) {
				for (const thread of pr.reviewThreads.edges) {
					if (thread.node.comments) {
						for (const comment of thread.node.comments.edges) {
							const commentNode = comment.node;
							if (commentNode.author && !isBotDenied(commentNode.author.login) &&
								commentNode.createdAt && commentNode.createdAt >= fromISO && commentNode.createdAt < toISO) {
								this.addContributorStat(commentNode.author.login, 'pr_comments', 1, repo);
							}
						}
					}
				}
			}
		}
	}

	async collectIssueComments(owner, name, fromISO, toISO, repo) {
		const query = `
			query($owner: String!, $name: String!, $first: Int!, $after: String) {
				repository(owner: $owner, name: $name) {
					issues(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
						edges {
							cursor
							node {
								number
								comments(first: 10) {
									edges {
										node {
											author {
												login
											}
											createdAt
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		const issues = await this.paginate(query, { owner, name }, 50, 'repository.issues');
		
		for (const issue of issues) {
			if (issue.comments) {
				for (const comment of issue.comments.edges) {
					const commentNode = comment.node;
					if (commentNode.author && !isBotDenied(commentNode.author.login) &&
						commentNode.createdAt && commentNode.createdAt >= fromISO && commentNode.createdAt < toISO) {
						this.addContributorStat(commentNode.author.login, 'issue_comments', 1, repo);
					}
				}
			}
		}
	}

	// Helper methods for tracking stats
	addContributorStat(login, field, value, repo = null) {
		// Global stats
		if (!this.contributorStats.has(login)) {
			this.contributorStats.set(login, {
				login,
				merged_prs: 0,
				reviews: 0,
				commits: 0,
				issues_closed: 0,
				pr_comments: 0,
				issue_comments: 0,
				additions: 0,
				deletions: 0,
			});
		}
		this.contributorStats.get(login)[field] += value;

		// Per-repo stats
		if (repo) {
			if (!this.repoContributorStats.has(repo)) {
				this.repoContributorStats.set(repo, new Map());
			}
			const repoStats = this.repoContributorStats.get(repo);
			if (!repoStats.has(login)) {
				repoStats.set(login, {
					login,
					merged_prs: 0,
					reviews: 0,
					commits: 0,
					issues_closed: 0,
					pr_comments: 0,
					issue_comments: 0,
					additions: 0,
					deletions: 0,
				});
			}
			repoStats.get(login)[field] += value;
		}
	}

	incrementRepoStat(owner, name, field) {
		// This will be used to track repo-level counts
		const repoKey = `${owner}/${name}`;
		if (!this.repoCounts) {
			this.repoCounts = new Map();
		}
		if (!this.repoCounts.has(repoKey)) {
			this.repoCounts.set(repoKey, {
				mergedPRs: 0,
				openPRs: 0,
				closedIssues: 0,
				newIssues: 0,
			});
		}
		this.repoCounts.get(repoKey)[field]++;
	}

	getMergedPRCount(owner, name) {
		return this.repoCounts?.get(`${owner}/${name}`)?.mergedPRs || 0;
	}

	getOpenPRCount(owner, name) {
		return this.repoCounts?.get(`${owner}/${name}`)?.openPRs || 0;
	}

	getClosedIssueCount(owner, name) {
		return this.repoCounts?.get(`${owner}/${name}`)?.closedIssues || 0;
	}

	getNewIssueCount(owner, name) {
		return this.repoCounts?.get(`${owner}/${name}`)?.newIssues || 0;
	}

	extractEdges(data) {
		// This method will be overridden for specific queries
		return [];
	}
}

// Output generators
class OutputGenerator {
	static generateCSV(contributorStats, outputPath) {
		const sortedStats = Array.from(contributorStats.values())
			.sort((a, b) => {
				// Sort by merged_prs desc, then commits desc, then reviews desc
				if (b.merged_prs !== a.merged_prs) return b.merged_prs - a.merged_prs;
				if (b.commits !== a.commits) return b.commits - a.commits;
				return b.reviews - a.reviews;
			});

		const headers = [
			'login',
			'merged_prs',
			'reviews',
			'commits',
			'issues_closed',
			'pr_comments',
			'issue_comments',
			'additions',
			'deletions'
		];

		const csvContent = [
			headers.join(','),
			...sortedStats.map(stat => 
				headers.map(header => stat[header] || 0).join(',')
			)
		].join('\n');

		writeFileSync(outputPath, csvContent);
		console.log(`CSV written to: ${outputPath}`);
	}

	static generateJSON(contributorStats, month, fromISO, toISO, outputPath) {
		const sortedStats = Array.from(contributorStats.values())
			.sort((a, b) => {
				if (b.merged_prs !== a.merged_prs) return b.merged_prs - a.merged_prs;
				if (b.commits !== a.commits) return b.commits - a.commits;
				return b.reviews - a.reviews;
			});

		const data = {
			month,
			fromISO,
			toISO,
			generatedAt: new Date().toISOString(),
			contributors: sortedStats
		};

		writeFileSync(outputPath, JSON.stringify(data, null, 2));
		console.log(`JSON written to: ${outputPath}`);
	}

	static generateMarkdownReport(repoStats, contributorStats, month, outputPath) {
		const monthName = new Date(Date.UTC(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]) - 1, 1))
			.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

		// Calculate totals
		const totals = repoStats.reduce((acc, repo) => ({
			mergedPRs: acc.mergedPRs + repo.mergedPRs,
			openPRs: acc.openPRs + repo.openPRs,
			closedIssues: acc.closedIssues + repo.closedIssues,
			newIssues: acc.newIssues + repo.newIssues,
		}), { mergedPRs: 0, openPRs: 0, closedIssues: 0, newIssues: 0 });

		// Generate repo table
		const repoTable = [
			'| Github Repo | Merged PRs | Open PRs | Closed Issues | New Issues |',
			'|---|---:|---:|---:|---:|',
			...repoStats.map(repo => 
				`| [${repo.name}](${repo.url}) | ${repo.mergedPRs} | ${repo.openPRs} | ${repo.closedIssues} | ${repo.newIssues} |`
			),
			`| **Total** | **${totals.mergedPRs}** | **${totals.openPRs}** | **${totals.closedIssues}** | **${totals.newIssues}** |`
		].join('\n');

		// Generate contributor shoutouts
		const sortedContributors = Array.from(contributorStats.values())
			.sort((a, b) => {
				if (b.merged_prs !== a.merged_prs) return b.merged_prs - a.merged_prs;
				if (b.commits !== a.commits) return b.commits - a.commits;
				return b.reviews - a.reviews;
			});

		const topPRAuthors = sortedContributors
			.filter(c => c.merged_prs > 0)
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const topReviewers = Array.from(contributorStats.values())
			.filter(c => c.reviews > 0)
			.sort((a, b) => b.reviews - a.reviews)
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const topCommenters = Array.from(contributorStats.values())
			.filter(c => (c.pr_comments + c.issue_comments) > 0)
			.sort((a, b) => (b.pr_comments + b.issue_comments) - (a.pr_comments + a.issue_comments))
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const contributorCount = contributorStats.size;

		const markdown = `## Github stats (${monthName.toUpperCase()})

${repoTable}

Thanks to everyone who contributed this month — we saw a lot of activity and new contributors.

- **${contributorCount} contributors** contributed to these repositories.
- **Top PR authors:** ${topPRAuthors || 'None this month'}
- **Top reviewers:** ${topReviewers || 'None this month'}
- **Top commenters:** ${topCommenters || 'None this month'}
`;

		writeFileSync(outputPath, markdown);
		console.log(`Markdown report written to: ${outputPath}`);
	}

	static generateEnhancedMarkdownReport(repoStats, contributorStats, repoContributorStats, month, fromISO, toISO, outputPath) {
		const monthName = new Date(Date.UTC(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]) - 1, 1))
			.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

		// Calculate totals
		const totals = repoStats.reduce((acc, repo) => ({
			mergedPRs: acc.mergedPRs + repo.mergedPRs,
			openPRs: acc.openPRs + repo.openPRs,
			closedIssues: acc.closedIssues + repo.closedIssues,
			newIssues: acc.newIssues + repo.newIssues,
		}), { mergedPRs: 0, openPRs: 0, closedIssues: 0, newIssues: 0 });

		// Generate repo table
		const repoTable = [
			'| Github Repo | Merged PRs | Open PRs | Closed Issues | New Issues |',
			'|---|---:|---:|---:|---:|',
			...repoStats.map(repo => 
				`| [${repo.name}](${repo.url}) | ${repo.mergedPRs} | ${repo.openPRs} | ${repo.closedIssues} | ${repo.newIssues} |`
			),
			`| **Total** | **${totals.mergedPRs}** | **${totals.openPRs}** | **${totals.closedIssues}** | **${totals.newIssues}** |`
		].join('\n');

		// Generate contributor shoutouts
		const sortedContributors = Array.from(contributorStats.values())
			.sort((a, b) => {
				if (b.merged_prs !== a.merged_prs) return b.merged_prs - a.merged_prs;
				if (b.commits !== a.commits) return b.commits - a.commits;
				return b.reviews - a.reviews;
			});

		const topPRAuthors = sortedContributors
			.filter(c => c.merged_prs > 0)
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const topReviewers = Array.from(contributorStats.values())
			.filter(c => c.reviews > 0)
			.sort((a, b) => b.reviews - a.reviews)
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const topCommenters = Array.from(contributorStats.values())
			.filter(c => (c.pr_comments + c.issue_comments) > 0)
			.sort((a, b) => (b.pr_comments + b.issue_comments) - (a.pr_comments + a.issue_comments))
			.slice(0, 3)
			.map(c => `@${c.login}`)
			.join(', ');

		const contributorCount = contributorStats.size;

		// Generate per-repo contributor breakdown
		const repoBreakdowns = [];
		for (const [repoName, repoContributors] of repoContributorStats) {
			const sortedRepoContributors = Array.from(repoContributors.values())
				.filter(c => c.merged_prs > 0 || c.reviews > 0 || c.commits > 0 || c.issues_closed > 0 || c.pr_comments > 0 || c.issue_comments > 0)
				.sort((a, b) => {
					const aTotal = a.merged_prs + a.reviews + a.commits + a.issues_closed + a.pr_comments + a.issue_comments;
					const bTotal = b.merged_prs + b.reviews + b.commits + b.issues_closed + b.pr_comments + b.issue_comments;
					return bTotal - aTotal;
				});

			if (sortedRepoContributors.length > 0) {
				const repoDisplayName = repoName.replace('wordpress/', '').replace('WordPress/', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
				repoBreakdowns.push(`### ${repoDisplayName}`);
				repoBreakdowns.push('');
				repoBreakdowns.push('| Username | Merged PRs | Reviews | Commits | Issues Closed | PR Comments | Issue Comments |');
				repoBreakdowns.push('|----------|:----------:|:-------:|:-------:|:-------------:|:-----------:|:--------------:|');
				
				for (const contributor of sortedRepoContributors) {
					repoBreakdowns.push(`| @${contributor.login} | ${contributor.merged_prs} | ${contributor.reviews} | ${contributor.commits} | ${contributor.issues_closed} | ${contributor.pr_comments} | ${contributor.issue_comments} |`);
				}
				repoBreakdowns.push('');
			}
		}

		const markdown = `# GitHub Stats - ${monthName.toUpperCase()}

**Generated:** ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour12: false })} UTC  
**Period:** ${new Date(fromISO).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} - ${new Date(toISO).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}  
**Total Contributors:** ${contributorCount}

## Repository Overview

${repoTable}

Thanks to the Hosting Team at Contributor Day of WordCamp US 2025, we saw a lot of activity and new contributors.

- **${contributorCount} contributors** contributed to Hosting repositories.
- **The most active Github contributors were:** ${topPRAuthors || 'None this month'}

## Per-Repository Contributor Breakdown

${repoBreakdowns.join('\n')}

---

*This report was generated automatically from GitHub data for the Hosting Team repositories during ${monthName} 2025.*
`;

		writeFileSync(outputPath, markdown);
		console.log(`Enhanced markdown report written to: ${outputPath}`);
	}
}

// Main execution
async function main() {
	try {
		const collector = new RepoStatsCollector(GITHUB_TOKEN);
		const { contributorStats, repoContributorStats, repoStats } = await collector.collectStats(REPOS, fromISO, toISO);

		// Create reports folder structure
		const reportsDir = join('reports', MONTH);
		mkdirSync(reportsDir, { recursive: true });

		// Generate outputs
		const csvPath = join(reportsDir, `${OUTPUT_BASENAME}-${MONTH}.csv`);
		const jsonPath = join(reportsDir, `${OUTPUT_BASENAME}-${MONTH}.json`);
		const markdownPath = join(reportsDir, 'report.md');
		const enhancedMarkdownPath = join(reportsDir, `${OUTPUT_BASENAME}-${MONTH}-enhanced.md`);

		OutputGenerator.generateCSV(contributorStats, csvPath);
		OutputGenerator.generateJSON(contributorStats, MONTH, fromISO, toISO, jsonPath);
		OutputGenerator.generateMarkdownReport(repoStats, contributorStats, MONTH, markdownPath);
		OutputGenerator.generateEnhancedMarkdownReport(repoStats, contributorStats, repoContributorStats, MONTH, fromISO, toISO, enhancedMarkdownPath);

		console.log('\n✅ All outputs generated successfully!');
		console.log(`📊 ${contributorStats.size} contributors processed`);
		console.log(`📁 ${repoStats.length} repositories processed`);

	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

// Run the script
main();
