// Jira watcher: tickets assigned to Gridbuild, found with the REST v3 enhanced search
// (/rest/api/3/search/jql). Posts status comments back on the ticket.
// Credentials come from JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.
import type { Task, Watcher } from '../types.ts';

const FIELDS = 'summary,description,issuetype,priority,labels,status';
const MAX_PAGES = 5;

type AdfNode = { type?: string; text?: string; attrs?: Record<string, any>; content?: AdfNode[] };

/** Plain text from Atlassian Document Format, the rich-text format v3 returns. */
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const inner = () => (node.content ?? []).map(adfToText).join('');
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text ?? '@someone';
    case 'emoji': return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard': return node.attrs?.url ?? '';
    case 'paragraph':
    case 'heading': return `${inner()}\n\n`;
    case 'listItem': return `- ${inner().trim()}\n`;
    case 'bulletList':
    case 'orderedList': return `${inner()}\n`;
    case 'codeBlock': return `\`\`\`\n${inner()}\n\`\`\`\n\n`;
    case 'blockquote': return `${inner().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
    case 'doc': return inner().replace(/\n{3,}/g, '\n\n').trim();
    default: return inner();
  }
}

/** A one-paragraph ADF comment, with links clickable. */
export function textToAdf(text: string): AdfNode {
  const content = text.split(/(https?:\/\/\S+)/).filter(Boolean).map((part) =>
    /^https?:\/\//.test(part)
      ? { type: 'text', text: part, marks: [{ type: 'link', attrs: { href: part } }] }
      : { type: 'text', text: part },
  );
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] } as AdfNode;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
  };
}

export function jiraIssueToTask(issue: JiraIssue, baseUrl: string): Task {
  const f = issue.fields ?? {};
  const facts = [
    f.issuetype?.name && `Type: ${f.issuetype.name}`,
    f.priority?.name && `Priority: ${f.priority.name}`,
    f.labels?.length && `Labels: ${f.labels.join(', ')}`,
  ].filter(Boolean).join(' · ');
  return {
    id: `jira-${issue.key}`,
    source: 'jira',
    ref: issue.key,
    title: f.summary ?? issue.key,
    body: [adfToText(f.description).trim(), facts].filter(Boolean).join('\n\n'),
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

export function jiraWatcher(opts: { baseUrl: string; email: string; token: string; jql: string; fetch?: typeof fetch }): Watcher {
  const doFetch = opts.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`;

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && method === 'GET') return undefined;
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Jira ${method} ${path.split('?')[0]} returned ${res.status}${text ? `: ${text}` : ''}`);
    }
    return res.status === 204 ? undefined : res.json();
  }

  return {
    name: 'jira',

    async poll() {
      const tasks: Task[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ jql: opts.jql, fields: FIELDS, maxResults: '50' });
        if (token) params.set('nextPageToken', token);
        const data = await request('GET', `/rest/api/3/search/jql?${params}`);
        tasks.push(...((data?.issues ?? []) as JiraIssue[]).map((i) => jiraIssueToTask(i, opts.baseUrl)));
        token = data?.nextPageToken;
        if (data?.isLast !== false || !token) break;
      }
      return tasks;
    },

    async get(key) {
      const issue = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS}`);
      return issue ? jiraIssueToTask(issue, opts.baseUrl) : undefined;
    },

    async notify(task, message) {
      await request('POST', `/rest/api/3/issue/${encodeURIComponent(task.ref)}/comment`, { body: textToAdf(message) });
    },
  };
}
