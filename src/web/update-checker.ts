import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'

export interface UpdateCommit {
  sha: string
  short: string
  message: string
  author: string
  date: string
}

export interface UpdateStatus {
  current: string
  latest: string
  behind: number
  aheadBy: number
  commits: UpdateCommit[]
  remote: string
  lastChecked: number
  error?: string
}

let updateStatusCache: UpdateStatus = {
  current: '',
  latest: '',
  behind: 0,
  aheadBy: 0,
  commits: [],
  remote: 'Szotasz/marveen',
  lastChecked: 0,
}

export function getUpdateStatus(): UpdateStatus {
  return updateStatusCache
}

export function currentGitHead(): string {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

export function parseGitHubRemote(): string {
  try {
    const url = execFileSync('/usr/bin/git', ['config', '--get', 'remote.origin.url'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
    // Normalize "git@github.com:Owner/Repo.git" or "https://github.com/Owner/Repo.git" to "Owner/Repo"
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
    if (m) return m[1]
  } catch { /* fall through */ }
  return 'Szotasz/marveen'
}

export async function refreshUpdateStatus(): Promise<UpdateStatus> {
  const current = currentGitHead()
  const remote = parseGitHubRemote()
  const status: UpdateStatus = {
    current,
    latest: '',
    behind: 0,
    aheadBy: 0,
    commits: [],
    remote,
    lastChecked: Date.now(),
  }
  if (!current) {
    status.error = 'Not a git checkout'
    updateStatusCache = status
    return status
  }
  try {
    // 1) find HEAD of default branch (main) via the commits endpoint
    const latestRes = await fetch(`https://api.github.com/repos/${remote}/commits/main`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' },
    })
    if (!latestRes.ok) throw new Error(`GitHub /commits/main -> ${latestRes.status}`)
    const latestJson = await latestRes.json() as { sha?: string }
    if (!latestJson.sha) throw new Error('No sha on commits/main response')
    status.latest = latestJson.sha

    if (status.latest === current) {
      updateStatusCache = status
      return status
    }

    // 2) list commits between current and latest via the compare endpoint
    const cmpRes = await fetch(`https://api.github.com/repos/${remote}/compare/${current}...${status.latest}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' },
    })
    if (cmpRes.ok) {
      const cmp = await cmpRes.json() as {
        ahead_by?: number
        commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
      }
      status.behind = cmp.ahead_by ?? 0
      // GitHub returns commits oldest-first; flip to newest-first for the UI.
      const raw = (cmp.commits ?? []).slice().reverse()
      status.commits = raw.map(c => ({
        sha: c.sha,
        short: c.sha.slice(0, 7),
        message: (c.commit.message || '').split('\n')[0],
        author: c.commit.author?.name || '',
        date: c.commit.author?.date || '',
      }))
    } else if (cmpRes.status === 404) {
      // Local HEAD isn't on GitHub (unpushed commits). Use local git to compute
      // the real behind/ahead counts relative to origin/main, then add any
      // additional commits GitHub has beyond origin/main (when origin/main is stale).
      // Total behind = (HEAD..origin/main locally) + (origin/main..GitHub-latest via API).
      try {
        const originMain = execFileSync(
          '/usr/bin/git', ['rev-parse', 'origin/main'],
          { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
        ).trim()

        const behindLocalStr = execFileSync(
          '/usr/bin/git', ['rev-list', '--count', 'HEAD..origin/main'],
          { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
        ).trim()
        const behindLocal = parseInt(behindLocalStr, 10) || 0

        const aheadStr = execFileSync(
          '/usr/bin/git', ['rev-list', '--count', 'origin/main..HEAD'],
          { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
        ).trim()
        status.aheadBy = parseInt(aheadStr, 10) || 0

        // Get local behind commits from git log (newest first)
        const localLogRaw = execFileSync(
          '/usr/bin/git',
          ['log', '--format=%H\t%s\t%an\t%aI', 'HEAD..origin/main'],
          { cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8' },
        ).trim()
        const localCommits: UpdateCommit[] = localLogRaw
          ? localLogRaw.split('\n').map(line => {
              const [sha = '', message = '', author = '', date = ''] = line.split('\t')
              return { sha, short: sha.slice(0, 7), message, author, date }
            })
          : []

        // If origin/main is stale (behind GitHub latest), add the remote delta
        let behindRemote = 0
        const remoteCommits: UpdateCommit[] = []
        if (originMain && originMain !== status.latest) {
          const cmp2Res = await fetch(
            `https://api.github.com/repos/${remote}/compare/${originMain}...${status.latest}`,
            { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' } },
          )
          if (cmp2Res.ok) {
            const cmp2 = await cmp2Res.json() as {
              ahead_by?: number
              commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
            }
            behindRemote = cmp2.ahead_by ?? 0
            const raw2 = (cmp2.commits ?? []).slice().reverse()
            remoteCommits.push(...raw2.map(c => ({
              sha: c.sha,
              short: c.sha.slice(0, 7),
              message: (c.commit.message || '').split('\n')[0],
              author: c.commit.author?.name || '',
              date: c.commit.author?.date || '',
            })))
          }
        }

        status.behind = behindLocal + behindRemote
        status.commits = [...remoteCommits, ...localCommits]
      } catch {
        // git rev-parse origin/main failed (no remote fetched yet) -- surface original error.
        status.error = 'Local HEAD not found on GitHub -- different fork or unpushed commits?'
      }
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }
  updateStatusCache = status
  return status
}

// Polls the GitHub repo's main branch for new commits and compares to the
// local HEAD. Lets the dashboard show a "new version available" badge
// without anyone having to SSH in and run update.sh.
export function startUpdateChecker(): NodeJS.Timeout {
  // First check shortly after startup; then every 15 minutes.
  setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)
  return setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)
}
