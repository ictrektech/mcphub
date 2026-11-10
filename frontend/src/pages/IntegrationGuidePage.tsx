import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import LanguageSwitch from '../components/ui/LanguageSwitch';
import { EndpointCopy } from '../components/ui/EndpointCopy';
import { getBasePath } from '../utils/runtime';

const userTokenExample = `const oauth = window.vos_platform.api.v1000.oauth2;
const clientId = 'com.ictrek.your-app'; // Register your app's own OIDC client.
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const verifier = random(), state = random();
const challenge = btoa(String.fromCharCode(...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const grant = await oauth.authorize({
  client_id: clientId, response_type: 'code', scope: 'openid profile email',
  state, nonce: random(), code_challenge: challenge, code_challenge_method: 'S256'
});
if (grant.state !== state) throw new Error('OIDC state mismatch');
const tokens = await oauth.token({
  grant_type: 'authorization_code', client_id: clientId,
  code: grant.code, code_verifier: verifier
});
const userToken = tokens.access_token;
// Keep tokens in memory. Refresh through oauth.token with grant_type: 'refresh_token'.`;

const appMountExample = `# In the CONSUMER application's Compose service:
networks:
  vos_default:
    aliases: [your-app]
volumes:
  - \${VOS_APP_CONTEXT_PATH:-}:/var/lib/vos-context:ro
environment:
  MCPHUB_URL: http://mcphub:3000/app/com.ictrek.mcphub`;

export default function IntegrationGuidePage() {
  const { t, i18n } = useTranslation();
  const base = `${window.location.origin}${getBasePath()}`;
  const discovery = `${base}/api/integration/discovery`;
  const whoami = `${base}/api/integration/whoami`;
  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        vos_mcphub: {
          url: `${base}/mcp`,
          headers: { Authorization: 'Bearer <VOS_USER_TOKEN_OR_MCPHUB_USER_KEY>' },
        },
      },
    },
    null,
    2,
  );
  const verifyExample = `// Consumer backend: verify the user token with VOS, never trust browser identity fields.
const response = await fetch(process.env.VOS_USERINFO_URL, {
  headers: { Authorization: \`Bearer \${userToken}\` },
  redirect: 'error', signal: AbortSignal.timeout(5000)
});
if (!response.ok) throw new Error('VOS verification rejected');
const user = await response.json();
if (!user.sub || user.enable !== 1) throw new Error('Invalid or disabled user');
// Use user.sub as the stable identity. Do not decode a JWT and trust its role.

// MCPHub also provides a minimal authenticated identity endpoint:
const checked = await fetch('${whoami}', { headers: { Authorization: \`Bearer \${userToken}\` } });
if (!checked.ok) throw new Error('Identity verification rejected');
const {data: identity} = await checked.json();
if (identity.kind !== 'user') throw new Error('A human user token is required');`;
  const automaticExample = `import fs from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const hub = process.env.MCPHUB_URL || 'http://mcphub:3000/app/com.ictrek.mcphub';
// Backend/privileged startup helper only; never send this app credential to a browser.
const token = (await fs.readFile('/var/lib/vos-context/access-token', 'utf8')).trim();
const headers = { Authorization: \`Bearer \${token}\` };
const response = await fetch(hub + '/api/integration/discovery', {
  headers, signal: AbortSignal.timeout(5000)
});
if (!response.ok) throw new Error('MCPHub discovery unavailable');
const { data } = await response.json();
const mcpUrl = new URL(data.mcp_path, new URL(hub).origin);
const client = new Client({ name: 'your-app', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
const { tools } = await client.listTools();
// Select a discovered tool, then client.callTool({ name, arguments }).
await client.close();`;
  const curlExample = `curl --fail --silent --show-error '${discovery}' \\
  --header "Authorization: Bearer $VOS_TOKEN"`;
  const sections = [
    { id: 'identity', title: t('guide.identityTitle'), text: t('guide.identityText') },
    {
      id: 'user-token',
      title: t('guide.userTokenTitle'),
      text: t('guide.userTokenText'),
      code: userTokenExample,
    },
    {
      id: 'verify',
      title: t('guide.verifyTitle'),
      text: t('guide.verifyText'),
      code: verifyExample,
    },
    {
      id: 'app-token',
      title: t('guide.appTokenTitle'),
      text: t('guide.appTokenText'),
      code: appMountExample,
    },
    {
      id: 'discovery',
      title: t('guide.discoveryTitle'),
      text: t('guide.discoveryText'),
      code: curlExample,
    },
    {
      id: 'automatic',
      title: t('guide.automaticTitle'),
      text: t('guide.automaticText'),
      code: automaticExample,
    },
    {
      id: 'clients',
      title: t('guide.clientsTitle'),
      text: t('guide.clientsText'),
      code: clientConfig,
    },
    { id: 'permissions', title: t('guide.permissionsTitle'), text: t('guide.permissionsText') },
    { id: 'operations', title: t('guide.operationsTitle'), text: t('guide.operationsText') },
  ];
  return (
    <main
      className="min-h-screen p-6 md:p-10"
      style={{ background: 'var(--hub-bg)', color: 'var(--hub-ink)' }}
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <Link className="hub-btn" to="/servers">
            {t('nav.servers')}
          </Link>
          <LanguageSwitch />
        </header>
        <div>
          <h1 className="hub-h1">{t('guide.title')}</h1>
          <a
            className="hub-btn mt-3 inline-flex"
            href={`${getBasePath()}/api-reference.html#${i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en'}`}
          >
            {t('guide.referenceTitle')}
          </a>
          <p className="hub-sub">{t('guide.intro')}</p>
        </div>
        <section className="hub-card space-y-3 p-5" aria-label={t('guide.endpoints')}>
          <h2 className="font-semibold">{t('guide.endpoints')}</h2>
          <EndpointCopy url={`${base}/mcp`} label="MCP" />
          <EndpointCopy url={whoami} label={t('guide.identityLabel')} />
          <EndpointCopy url={discovery} label={t('guide.discoveryLabel')} />
        </section>
        {sections.map((section) => (
          <section key={section.id} id={section.id} className="hub-card space-y-3 p-5">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p
              className="whitespace-pre-line text-sm leading-7"
              style={{ color: 'var(--hub-ink-2)' }}
            >
              {section.text}
            </p>
            {section.code ? (
              <pre className="overflow-x-auto rounded-md bg-[var(--hub-bg-2)] p-4 text-xs leading-6">
                <code>{section.code}</code>
              </pre>
            ) : null}
          </section>
        ))}
      </div>
    </main>
  );
}
