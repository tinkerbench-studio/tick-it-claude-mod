import { globToRegExp } from './ui-evidence'

// The areas of an application where a mistake is a security problem. Each has a secure-coding skill of the
// plugin (skills/secure-<name>/SKILL.md), which the session writing the code follows and the security reviewer
// checks against, and a reading of a change that says whether it touches the area: its changed paths and the
// words on its changed lines. The reading is a first guess, made without a model: it decides that a reviewer
// runs and what it is told to look at, never what it finds.

export type SecurityArea = {
  /** The name a review skill lists in `changes`. */
  name: string
  /** What the area covers, as the brief and the reviewer are told. */
  what: string
  /** A changed path that puts the change in the area. */
  paths?: RegExp
  /** Words on a changed line that put the change in the area. */
  words?: RegExp
  /** When set, the words count only in a file whose path matches. */
  wordsIn?: RegExp
}

/** The plugin skill that holds an area's practices, and how Claude names it. */
export const AREA_SKILL_DIR = (area: string) => `skills/secure-${area}`
export const areaSkill = (area: string) => `tick-it:secure-${area}`

/** A path segment: the name alone, or with a prefix or suffix set off by a dot, a hyphen or an underscore ("auth.ts", "user-roles/", "oauth_callback.py"). */
const segment = (names: string) => new RegExp(`(^|[/._-])(${names})([/._-]|$)`, 'i')

export const SECURITY_AREAS: readonly SecurityArea[] = [
  {
    name: 'authentication',
    what: 'sign-in, sessions, passwords, tokens and account recovery',
    paths: segment('auth|authn|authentication|login|logout|signin|sign-in|signup|sign-up|oauth2?|oidc|saml|sso|passwords?|passkeys?|webauthn|mfa|2fa|totp|jwt|credentials'),
    words:
      /passw(or)?d|bcrypt|scrypt|argon2|pbkdf2|jsonwebtoken|\bjwt\b|\bjwks?\b|oauth|\boidc\b|\bsaml\b|webauthn|passkey|\btotp\b|\bmfa\b|\b2fa\b|sign[_-]?in|\blogin\(|login[_-]?(required|form|page|attempt)|\/login\b|log[_-]?out\b|sign[_-]?up|authenticat|set-cookie|session[_-]?(id|cookie|token|secret)|(refresh|access|id|reset|bearer)[_-]?token|\bbearer\b|magic[_-]?link|www-authenticate/i,
  },
  {
    name: 'access-control',
    what: 'permissions, roles, ownership and what one user or tenant may reach of another',
    paths: segment('authz|authori[sz]ation|permissions?|polic(y|ies)|roles?|rbac|abac|acls?|scopes?|access-control|ownership|members?|membership|tenants?|tenancy|admin'),
    // role="…" and role={…} are ARIA, not access.
    words:
      /permission|authori[sz]|\brbac\b|\bacls?\b|\broles?\b(?!\s*=\s*["'{])|is[_-]?admin|\badmin\b|superuser|\bsudo\b|owner[_-]?id|\btenant|\bscopes?\b|forbidden|\b40[13]\b|privilege|has[_-]?(role|permission|scope|access)|require[_-]?(role|auth|admin|scope|permission)|row[ _-]level[ _-]security|\bgrant\b|\brevoke\b|membership|allow[_-]?list|deny[_-]?list/i,
  },
  {
    name: 'database',
    what: 'SQL, queries, migrations and what a query lets a caller read or change',
    paths: /\.sql$|(^|[/._-])(migrations?|schema|prisma|drizzle|knex|sequelize|typeorm|db|database|queries)([/._-]|$)/i,
    words:
      /\bselect\b[^;\n]*\bfrom\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\b(create|alter|drop)\s+(table|index|view|policy|trigger|database|schema)\b|\.prepare\(|\.query\(|\.raw\(|\$queryRaw|\$executeRaw|\bsql`|createQueryBuilder|\border\s+by\b|\bwhere\b[^;\n]*=\s*[?$:]/i,
  },
  {
    name: 'infrastructure',
    what: 'infrastructure and deployment configuration: cloud resources, CI workflows, containers, network and runtime settings',
    paths:
      /\.(tf|tfvars|hcl)$|(^|\/)(terraform|infra|infrastructure|deploy|deployment|k8s|kubernetes|helm|charts|ansible|pulumi|cdk|cloudformation|nginx)\/|(^|\/)\.github\/(workflows|actions)\/|(^|\/)\.(circleci|gitlab-ci|buildkite)|(^|\/)(Dockerfile|Containerfile|Caddyfile|Procfile)[\w.-]*$|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$|(^|\/)(wrangler[\w.-]*\.(toml|jsonc?)|serverless\.ya?ml|vercel\.json|netlify\.toml|fly\.toml|firebase\.json|(firestore|storage|database)\.rules|cloudbuild\.ya?ml|buildspec\.ya?ml|app\.ya?ml|nginx\.conf|CODEOWNERS)$|(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.claude\/settings(\.local)?\.json$/i,
    words: /pull_request_target|0\.0\.0\.0\/0|::\/0|privileged:\s*true|publicly[_-]?accessible|allow[_-]?unauthenticated|assume[_-]?role|\biam\b/i,
  },
  {
    name: 'secrets',
    what: 'secrets, keys and cryptography: where they are kept, who can read them and what leaves in a log or an error',
    paths: /(^|[/._-])(secrets?|vault|kms|keys?|crypto|encrypt(ion)?|signing|signature|hmac)([/._-]|$)|\.(pem|key|p12|pfx|jks)$/i,
    words:
      /secret|api[_-]?key|private[_-]?key|credential|encrypt|decrypt|\bcipher|\bhmac\b|createHash|crypto\.(subtle|create|random|timingSafeEqual)|randomBytes|getRandomValues|\bmd5\b|\bsha-?1\b|BEGIN [A-Z ]*PRIVATE KEY|process\.env\.\w*(KEY|TOKEN|SECRET|PASSWORD)|\$\{\{\s*secrets\./i,
  },
  {
    name: 'input',
    what: 'input from outside reaching a shell, a file path, a parser, a redirect or a request to another host',
    paths: segment('uploads?|webhooks?'),
    words:
      /child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|process\.run\(|subprocess|os\.system|shell\s*[:=]\s*true|\beval\(|new Function\(|\bredirect\(|location\.(href|assign|replace)|multipart|multer|formidable|\bupload|xml2js|DOMParser|parseXml|yaml\.load\(|pickle|unserialize|deserializ|path\.(join|resolve)\([^)]*(req|param|input|query|body|name)|webhook/i,
  },
  {
    name: 'web',
    what: 'what the browser runs and sends: HTML built from data, cookies, cross-site requests, CORS and response headers',
    words:
      /innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write|v-html|bypassSecurityTrust|\bsrcdoc\b|javascript:|httpOnly|sameSite|\bcookies?\b|\bcsrf\b|\bxsrf\b|access-control-allow|\bcors\b|content-security-policy|\bcsp\b|x-frame-options|frame-ancestors|strict-transport-security|postMessage|sanitiz|DOMPurify|escapeHtml/i,
  },
  {
    name: 'dependencies',
    what: 'third-party code: a dependency added, moved or unpinned, and what runs at install',
    paths:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[\w.-]*\.txt|Pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|\.npmrc|\.yarnrc(\.yml)?|\.claude-plugin\/marketplace\.json)$/i,
    // A dependency line of a package.json: a name with a version, a range, a tag or a place to fetch it from. Its own "version" is not one.
    words: /^\s*"(?!version")[@\w./-]+":\s*"(\^|~|>=?|<=?|\d+\.|\*|latest|next|npm:|git[+:]|github:|https?:|file:|link:|workspace:)/im,
    wordsIn: /(^|\/)package\.json$/,
  },
  {
    name: 'agents',
    what: 'a model in the loop: text from outside in a prompt, the tools and permissions an agent holds, and what its answer is trusted to do',
    paths: /(^|\/)\.mcp\.json$|(^|\/)hooks\.json$/i,
    words:
      /anthropic|openai|\bllm\b|system[_-]?prompt|messages\.create|tool_use|tool_result|mcp[_-]?servers?|agent\.spawn|subagent|bypassPermissions|dangerously[-_]?skip|dangerouslyDisable|allowed[_-]?tools|permission[_-]?mode|\bprompt\s*[:=(]|prompt[_-]?injection/i,
  },
  {
    name: 'personal-data',
    what: 'personal data: what is collected, logged, kept, exported and deleted',
    words:
      /\bpii\b|personal[_ -]?data|\bgdpr\b|\bccpa\b|date[_-]?of[_-]?birth|\bdob\b|passport|\bssn\b|national[_-]?insurance|card[_-]?number|\biban\b|geolocation|ip[_-]?address|analytics|\btracking\b|\bconsent\b|retention|data[_-]?export|delete[_-]?account|erasure|anonymi[sz]|pseudonymi[sz]/i,
  },
]

export const AREA_NAMES: readonly string[] = SECURITY_AREAS.map(a => a.name)

/** Prose and pictures put a change in no area, by path or by word: a guide to signing in, under docs/auth, changes no sign-in. */
const PROSE = /\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|webp|map)$|(^|\/)(LICEN[CS]E|NOTICE|CHANGELOG|AUTHORS)[\w.-]*$/i

/**
 * Lock files, tests and fixtures: their paths can put a change in an area, their words cannot.
 * A test that signs in changes no sign-in: the code it tests is read for itself.
 */
const NO_WORDS = /\.(lock|snap)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(^|\/)(tests?|__tests__|specs?|fixtures|__snapshots__|__mocks__|e2e)\/|\.(test|spec|stories)\.[a-z]+$|_test\.[a-z]+$/i

/** One changed file: its path and its changed lines (added and removed), where they could be read. */
export type ChangedFile = { path: string; lines: string }

/** What a change touches: each area with the files that put it there, in the order of SECURITY_AREAS. */
export type Touched = { area: string; files: string[] }

/** The areas a set of changed files touches, each with up to `keep` of the files that say so. */
export const touchedAreas = (files: readonly ChangedFile[], keep = 5): Touched[] =>
  SECURITY_AREAS.flatMap(area => {
    const hits = files.filter(f => !PROSE.test(f.path) && (area.paths?.test(f.path) === true || (area.words !== undefined && f.lines !== '' && !NO_WORDS.test(f.path) && (area.wordsIn === undefined || area.wordsIn.test(f.path)) && area.words.test(f.lines))))
    return hits.length === 0 ? [] : [{ area: area.name, files: hits.slice(0, keep).map(f => f.path) }]
  })

/**
 * The value of a review skill's `changes` front matter: the kinds of change that run it on a ticket of any size.
 * Area names ("all" for every one), and globs of the repository's own sensitive paths (an entry with a slash, a dot or a star).
 * "none" is no kind of change: the skill runs by size alone, whatever its base says.
 */
export type Changes = { areas: string[]; globs: string[] }

export const parseChanges = (value: string | undefined): Changes | undefined => {
  const entries = (value ?? '').split(/[\s,]+/).filter(e => e !== '')
  if (entries.length === 0) return undefined
  const names = entries.map(e => e.toLowerCase())
  if (names.includes('none')) return { areas: [], globs: [] }
  const areas = names.includes('all') ? [...AREA_NAMES] : AREA_NAMES.filter(a => names.includes(a))
  return { areas, globs: entries.filter(e => /[/.*]/.test(e)).slice(0, 20) }
}

/** The `changes` entries that are neither an area, "all", "none" nor a glob: a misspelt area would otherwise switch its trigger off without a word. */
export const unknownChanges = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .filter(e => e !== '' && !/[/.*]/.test(e) && !['all', 'none', ...AREA_NAMES].includes(e.toLowerCase()))

/** What of a change runs a skill with these `changes`: the touched areas it lists, and its own globs that a changed path matches (as an area named for the glob). */
export const changesFor = (changes: Changes | undefined, touched: readonly Touched[], paths: readonly string[], keep = 5): Touched[] => {
  if (changes === undefined) return []
  const own = changes.globs.flatMap(glob => {
    const re = globToRegExp(glob)
    const hits = paths.filter(p => re.test(p))
    return hits.length === 0 ? [] : [{ area: glob, files: hits.slice(0, keep) }]
  })
  return [...touched.filter(t => changes.areas.includes(t.area)), ...own]
}

/** "authentication (a.ts, b.ts); database (m.sql)": what a change touches, as a line. */
export const touchedLine = (touched: readonly Touched[]): string => touched.map(t => `${t.area} (${t.files.join(', ')})`).join('; ')

/**
 * The changed lines of each file of a `git diff -U0` patch: the added and removed lines, without their markers,
 * under the path of the file as it is after the change (before it, for a deleted file).
 */
export const patchFiles = (patch: string): ChangedFile[] => {
  const files: ChangedFile[] = []
  let current: { path: string; lines: string[] } | undefined
  let from = ''
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      from = ''
    } else if (line.startsWith('--- ')) from = line.slice(4).replace(/^a\//, '')
    else if (line.startsWith('+++ ')) {
      const to = line.slice(4).replace(/^b\//, '')
      const path = to === '/dev/null' ? from : to
      if (path !== '' && path !== '/dev/null') {
        current = { path, lines: [] }
        files.push({ path, lines: '' })
      }
    } else if (current !== undefined && (line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line.slice(1))
      const last = files.at(-1)
      if (last !== undefined) last.lines = current.lines.join('\n')
    }
  }
  return files
}

/** The brief's line on secure coding: the areas, how the skill of each is named, and that the reviewer checks against the same skills. */
export const SECURE_CODING_LINE = `Secure coding: before you write or change code in a security area, load its skill and follow it: ${areaSkill('<area>')}, where the area is ${AREA_NAMES.join(', ')}. A security reviewer runs on a ticket of any size whose change touches one of them, and checks the change against the same skill.`

/** What Claude is told the first time an edit of the ticket lands in an area. */
export const areaNudge = (areas: readonly string[]): string =>
  `tick-it: this edit is in ${areas.length === 1 ? 'a security area' : 'security areas'} (${areas.join(', ')}). Load ${areas.map(areaSkill).join(', ')} if you have not, check this edit and the rest of the change against ${areas.length === 1 ? 'it' : 'them'}, and fix what breaks a "Must" now: the security reviewer runs on this ticket whatever its size and checks the same rules.`
