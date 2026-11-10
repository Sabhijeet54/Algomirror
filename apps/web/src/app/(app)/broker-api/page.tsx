'use client';

import { Activity, CheckCircle2, Copy, Eye, EyeOff, Info, Link2, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type BrokerApiConfigView, type BrokerSlug, type SaveBrokerApiConfigInput, useBrokerApiConfig, useBrokerApiMutations } from '@/lib/broker-api';
import { formatDateTime } from '@/lib/format';
import { useMe, useMyBrokerAccounts } from '@/lib/queries';
import { cn } from '@/lib/utils';


function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Copy failed — select and copy manually'),
  );
}

/** Text/password field. For secrets, an empty value means "keep what is saved". */
function F({
  id,
  label,
  required,
  value,
  onChange,
  secret,
  saved,
  hint,
  type = 'text',
  inputMode,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  saved?: boolean;
  hint?: string;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label} {required ? <span className="text-destructive">*</span> : null}
        {secret && saved ? <span className="ml-2 text-xs font-normal text-success">● saved</span> : null}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={secret && !show ? 'password' : type}
          inputMode={inputMode}
          autoComplete={secret ? 'new-password' : 'off'}
          spellCheck={false}
          value={value}
          placeholder={secret && saved ? '•••••••• (leave blank to keep)' : ''}
          onChange={(e) => onChange(e.target.value)}
          className={secret ? 'pr-10' : undefined}
        />
        {secret ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? `Hide ${label}` : `Show ${label}`}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        ) : null}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

type FieldKey = 'clientCode' | 'apiKey' | 'apiSecret' | 'pin' | 'totpSecret' | 'mobile' | 'userId' | 'password' | 'twoFa';
interface FieldMeta {
  key: FieldKey;
  label: string;
  required?: boolean;
  secret?: boolean;
  numeric?: boolean;
  hint?: string;
}
interface BrokerMeta {
  slug: BrokerSlug;
  broker: BrokerApiConfigView['broker'];
  name: string;
  fields: FieldMeta[];
  /** Setup steps (after "buy a static IP"); `ip` and the redirect URL are filled in. */
  steps: (ip: string, redirect: React.ReactNode) => React.ReactNode[];
  /** Server-side login every trading morning. */
  autoLogin?: string;
  /** Optional pasted access token on Connect. */
  token?: string;
  /** Connect opens the broker's login page (unless a token is pasted). */
  browserLogin?: boolean;
  daily: string;
}

const PROXY_LABELS: Record<string, string> = { proxyHost: 'Static IP', proxyPort: 'Port' };

const BROKERS: BrokerMeta[] = [
  {
    slug: 'angel-one',
    broker: 'ANGEL_ONE',
    name: 'Angel One',
    fields: [
      { key: 'clientCode', label: 'Client Code', required: true },
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      { key: 'pin', label: 'PIN', required: true, secret: true, numeric: true },
      { key: 'totpSecret', label: 'TOTP secret (QR code key)', required: true, secret: true, hint: 'The key under the QR code when enabling TOTP (or the otpauth:// link)' },
    ],
    steps: (ip, redirect) => [
      <>Open <strong>smartapi.angelone.in</strong> → My Apps → <strong>Create App</strong>. Set <strong>Primary static IP</strong> = <code>{ip}</code>.</>,
      <>Redirect URL: {redirect}</>,
      <>Copy the app&apos;s <strong>API Key</strong>. In the Angel One app enable <strong>TOTP</strong> and copy the secret key shown under the QR code.</>,
    ],
    autoLogin: 'Auto-login every trading morning (around 8:45 AM IST) with my PIN + TOTP, so I don’t have to connect daily.',
    daily: 'With auto-login ON we reconnect you each trading morning; if it fails, press Connect Broker before 9:15 AM.',
  },
  {
    slug: 'dhan',
    broker: 'DHAN',
    name: 'Dhan',
    fields: [
      { key: 'clientCode', label: 'Dhan Client ID', required: true, hint: 'web.dhan.co → My Profile' },
      { key: 'pin', label: 'Dhan PIN (6 digits)', required: true, secret: true, numeric: true },
      { key: 'totpSecret', label: 'TOTP secret', required: true, secret: true, hint: 'web.dhan.co → My Profile → Setup TOTP — copy the key under the QR code' },
    ],
    steps: (ip) => [
      <>Log in at <strong>web.dhan.co</strong> → My Profile → <strong>Access DhanHQ APIs</strong>. Add static IP <code>{ip}</code> as the <strong>Primary IP</strong>.</>,
      <>In My Profile enable <strong>TOTP</strong> and copy the secret key shown under the QR code.</>,
      <>Optional: generate a 24-hour <strong>Access Token</strong> there and paste it below to connect without PIN / TOTP.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my Dhan PIN + TOTP (new 24-hour token daily).',
    token: 'Access Token (optional)',
    daily: 'Dhan tokens last 24 hours. With auto-login ON we generate a new one each morning; otherwise press Connect Broker before 9:15 AM.',
  },
  {
    slug: 'fyers',
    broker: 'FYERS',
    name: 'Fyers',
    fields: [
      { key: 'clientCode', label: 'Fyers Client ID (optional)' },
      { key: 'apiKey', label: 'App ID', required: true, secret: true, hint: 'Looks like XC4XXXXM-100' },
      { key: 'apiSecret', label: 'Secret ID', required: true, secret: true },
      { key: 'pin', label: 'Fyers PIN (optional)', secret: true, numeric: true, hint: 'Lets us refresh your session each morning without the login page (refresh token, valid ~15 days)' },
    ],
    steps: (ip, redirect) => [
      <>Open <strong>myapi.fyers.in</strong> → Dashboard → <strong>Create App</strong>. Add static IP <code>{ip}</code>.</>,
      <>Redirect URL: {redirect}</>,
      <>Copy the <strong>App ID</strong> and <strong>Secret ID</strong>.</>,
    ],
    autoLogin: 'Refresh my Fyers session every trading morning with my PIN (after one Connect Broker login).',
    browserLogin: true,
    daily: 'Fyers sessions end at 6:30 AM. With PIN + auto-refresh ON we renew it each morning; the login page is needed again about every 15 days.',
  },
  {
    slug: 'kotak-neo',
    broker: 'KOTAK_NEO',
    name: 'Kotak Neo',
    fields: [
      { key: 'clientCode', label: 'UCC (client code)', required: true, hint: 'Neo app → Profile' },
      { key: 'mobile', label: 'Registered mobile number', required: true, secret: true, hint: 'e.g. +919876543210' },
      { key: 'apiKey', label: 'Consumer Key (Trade API token)', required: true, secret: true, hint: 'Neo app → More → Trade API → Create application → copy the token' },
      { key: 'pin', label: 'MPIN', required: true, secret: true, numeric: true },
      { key: 'totpSecret', label: 'TOTP secret', required: true, secret: true, hint: 'Trade API dashboard → TOTP Registration — copy the key under the QR code' },
    ],
    steps: (ip) => [
      <>In the <strong>Kotak Neo</strong> app: More → <strong>Trade API</strong> → create an application and copy its token (Consumer Key). Register static IP <code>{ip}</code> there.</>,
      <>On the same page do <strong>TOTP Registration</strong> and copy the secret key shown under the QR code.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my MPIN + TOTP.',
    daily: 'Kotak Neo sessions end daily. With auto-login ON we reconnect you each morning; otherwise press Connect Broker before 9:15 AM.',
  },
  {
    slug: '5paisa',
    broker: 'FIVE_PAISA',
    name: '5paisa',
    fields: [
      { key: 'clientCode', label: 'Client Code', required: true },
      { key: 'apiKey', label: 'User Key', required: true, secret: true },
      { key: 'apiSecret', label: 'Encryption Key', required: true, secret: true },
      { key: 'userId', label: 'User ID (API)', required: true, secret: true, hint: 'From xstream.5paisa.com → Dashboard (API keys)' },
      { key: 'pin', label: 'PIN', required: true, secret: true, numeric: true },
      { key: 'totpSecret', label: 'TOTP secret', required: true, secret: true },
    ],
    steps: (ip) => [
      <>Open <strong>xstream.5paisa.com</strong> → Dashboard → create API keys. Whitelist static IP <code>{ip}</code>.</>,
      <>Copy <strong>User Key</strong>, <strong>Encryption Key</strong> and <strong>User ID</strong>. Enable <strong>TOTP</strong> in the 5paisa app and copy its secret key.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my PIN + TOTP.',
    daily: '5paisa tokens expire at 11:59 PM. With auto-login ON we reconnect you each morning; otherwise press Connect Broker before 9:15 AM.',
  },
  {
    slug: 'alice-blue',
    broker: 'ALICE_BLUE',
    name: 'Alice Blue',
    fields: [
      { key: 'clientCode', label: 'User ID (client code)', required: true, hint: 'e.g. AB123456' },
      { key: 'apiKey', label: 'API Key', required: true, secret: true, hint: 'ant.aliceblueonline.com → Apps → API key' },
    ],
    steps: (ip) => [
      <>Log in to <strong>ant.aliceblueonline.com</strong> → Apps / API → generate your <strong>API Key</strong>. Whitelist static IP <code>{ip}</code>.</>,
      <>Enter your Alice Blue <strong>User ID</strong> and the <strong>API Key</strong>, save, then press Connect Broker.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my API key.',
    daily: 'Alice Blue sessions end daily. With auto-login ON we reconnect you each morning (you may need to log in once on the Alice Blue app/web that day).',
  },
  {
    slug: 'groww',
    broker: 'GROWW',
    name: 'Groww',
    fields: [
      { key: 'clientCode', label: 'Groww Client ID (UCC)', required: true, hint: 'Groww app → Profile → your client ID' },
      { key: 'apiKey', label: 'API Key (TOTP type)', required: true, secret: true, hint: 'groww.in/trade-api/api-keys → Generate API key → choose TOTP' },
      { key: 'totpSecret', label: 'TOTP secret', required: true, secret: true, hint: 'Shown with the QR code when you create the TOTP API key' },
    ],
    steps: (ip) => [
      <>Subscribe to <strong>Groww Trade API</strong>, then open <strong>groww.in/trade-api/api-keys</strong> → Generate API key → <strong>TOTP</strong>. Whitelist static IP <code>{ip}</code>.</>,
      <>Copy the <strong>API Key</strong> and the <strong>TOTP secret</strong> shown under the QR code.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my Groww API key + TOTP.',
    daily: 'Groww tokens expire every day at 6:00 AM. With auto-login ON we reconnect you each morning; otherwise press Connect Broker before 9:15 AM.',
  },
  {
    slug: 'motilal-oswal',
    broker: 'MOTILAL_OSWAL',
    name: 'Motilal Oswal',
    fields: [
      { key: 'clientCode', label: 'User ID (client code)', required: true },
      { key: 'apiKey', label: 'API Key', required: true, secret: true, hint: 'invest.motilaloswal.com → Trading API → API key' },
      { key: 'apiSecret', label: 'API Secret Key (if shown)', secret: true },
      { key: 'password', label: 'Login password', required: true, secret: true },
      { key: 'twoFa', label: 'Date of birth (DD/MM/YYYY) or PAN', required: true, secret: true, hint: 'Second factor Motilal asks for at login' },
      { key: 'totpSecret', label: 'TOTP secret', required: true, secret: true, hint: 'Enable authenticator TOTP and copy the key under the QR code' },
    ],
    steps: (ip) => [
      <>Log in to <strong>invest.motilaloswal.com</strong> → Trading API → create your <strong>API Key</strong>. Register static IP <code>{ip}</code>.</>,
      <>Enable <strong>authenticator TOTP</strong> for your login and copy the secret key shown under the QR code.</>,
    ],
    autoLogin: 'Auto-login every trading morning with my password + TOTP.',
    daily: 'Motilal Oswal sessions end at 6:00 AM daily. With auto-login ON we reconnect you each morning; otherwise press Connect Broker before 9:15 AM.',
  },
  {
    slug: 'upstox',
    broker: 'UPSTOX',
    name: 'Upstox',
    fields: [
      { key: 'clientCode', label: 'Client Code (Upstox user ID, optional)' },
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      { key: 'apiSecret', label: 'API Secret', required: true, secret: true },
    ],
    steps: (ip, redirect) => [
      <>Open <strong>account.upstox.com/developer/apps</strong> → <strong>New app</strong>. Add static IP <code>{ip}</code> to the app.</>,
      <>Redirect URL: {redirect}</>,
      <>Copy the app&apos;s <strong>API Key</strong> and <strong>API Secret</strong>. Optional: generate an <strong>Access Token</strong> and paste it below.</>,
    ],
    token: 'Access Token (optional)',
    browserLogin: true,
    daily: 'Upstox tokens expire every night (~3:30 AM) — press Connect Broker (or paste a new access token) every trading day before 9:15 AM.',
  },
  {
    slug: 'zerodha',
    broker: 'ZERODHA',
    name: 'Zerodha',
    fields: [
      { key: 'clientCode', label: 'User ID (optional)' },
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      { key: 'apiSecret', label: 'API Secret', required: true, secret: true },
    ],
    steps: (ip, redirect) => [
      <>Open <strong>developers.kite.trade</strong> → <strong>Create new app</strong>. Whitelist IP <code>{ip}</code>.</>,
      <>Redirect URL: {redirect}</>,
      <>Copy the app&apos;s <strong>API Key</strong> and <strong>API Secret</strong>.</>,
    ],
    browserLogin: true,
    daily: 'Zerodha requires a browser login — press Connect Broker every trading day before 9:15 AM.',
  },
];
const META = Object.fromEntries(BROKERS.map((b) => [b.slug, b])) as Record<BrokerSlug, BrokerMeta>;

function SetupSteps({ meta, cfg }: { meta: BrokerMeta; cfg?: BrokerApiConfigView }) {
  const ip = cfg?.lastTest?.ip ?? cfg?.proxyHost ?? 'your static IP';
  const redirect = (
    <button type="button" className="inline-flex items-center gap-1 break-all font-mono text-primary hover:underline" onClick={() => copy(cfg?.redirectUrl ?? '')}>
      {cfg?.redirectUrl} <Copy className="size-3.5 shrink-0" />
    </button>
  );
  return (
    <details className="rounded-lg border bg-muted/30 p-4 text-sm" open={!cfg?.complete}>
      <summary className="cursor-pointer font-medium">
        <Info className="mr-1 inline size-4" /> Setup steps — {meta.name}
      </summary>
      <ol className="mt-3 grid list-decimal gap-2 pl-5 text-muted-foreground">
        <li>Buy a dedicated <strong>India static IP proxy</strong> (HTTP proxy, 24×7). Note its IP, port, username and password.</li>
        {meta.steps(ip, redirect).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        <li>Fill the form below → <strong>Save</strong> → <strong>Test proxy health</strong> → <strong>Connect Broker</strong>.</li>
      </ol>
    </details>
  );
}

const BLANK = { clientCode: '', apiKey: '', apiSecret: '', pin: '', totpSecret: '', mobile: '', userId: '', password: '', twoFa: '', proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: '' };
type Form = typeof BLANK;

function BrokerForm({ broker }: { broker: BrokerSlug }) {
  const meta = META[broker];
  const q = useBrokerApiConfig(broker);
  const { save, test, connect } = useBrokerApiMutations(broker);
  const accounts = useMyBrokerAccounts();
  const account = accounts.data?.find((a) => a.broker === meta.broker);
  const cfg = q.data;
  const [f, setF] = useState<Form>(BLANK);
  const [autoLogin, setAutoLogin] = useState(true);
  const [consent, setConsent] = useState(false);
  const [accessToken, setAccessToken] = useState('');

  useEffect(() => {
    if (!cfg) return;
    setF({ ...BLANK, clientCode: cfg.clientCode ?? '', proxyHost: cfg.proxyHost ?? '', proxyPort: cfg.proxyPort ? String(cfg.proxyPort) : '' });
    setAutoLogin(cfg.autoLogin);
    setConsent(Boolean(cfg.consentAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.clientCode, cfg?.proxyHost, cfg?.proxyPort, cfg?.autoLogin, cfg?.consentAt]);

  const set = (k: keyof Form) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const dirty = (Object.entries(f) as [keyof Form, string][]).some(([k, v]) =>
    k === 'clientCode' ? v !== (cfg?.clientCode ?? '') : k === 'proxyHost' ? v !== (cfg?.proxyHost ?? '') : k === 'proxyPort' ? v !== (cfg?.proxyPort ? String(cfg.proxyPort) : '') : v !== '',
  );
  const labelOf = (k: string) => meta.fields.find((x) => x.key === k)?.label ?? PROXY_LABELS[k] ?? k;

  const doSave = () => {
    if (!consent) return toast.error('Please accept the consent to store your credentials');
    const body: SaveBrokerApiConfigInput = {
      clientCode: f.clientCode,
      proxyHost: f.proxyHost,
      proxyPort: f.proxyPort ? Number(f.proxyPort) : undefined,
      proxyUser: f.proxyUser,
      proxyPass: f.proxyPass,
      autoLogin: meta.autoLogin ? autoLogin : undefined,
      consent: true,
    };
    for (const fld of meta.fields) if (fld.key !== 'clientCode') (body as Record<string, unknown>)[fld.key] = f[fld.key];
    save.mutate(body, {
      onSuccess: (v) => {
        setF((p) => ({ ...p, apiKey: '', apiSecret: '', pin: '', totpSecret: '', mobile: '', userId: '', password: '', twoFa: '', proxyUser: '', proxyPass: '' }));
        toast.success(v.complete ? 'Saved — now test proxy health and connect' : `Saved. Still missing: ${v.missing.map(labelOf).join(', ')}`);
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const pasted = Boolean(meta.token && accessToken.trim());
  const doConnect = () =>
    connect.mutate(pasted ? { accessToken: accessToken.trim() } : undefined, {
      onSuccess: (r) => {
        if (r.loginUrl) {
          window.location.href = r.loginUrl;
          return;
        }
        setAccessToken('');
        toast.success(`${meta.name} connected through your static IP`);
      },
      onError: (e) => toast.error(e.message),
    });

  // A pasted token replaces PIN / TOTP (Dhan) or the API secret (Upstox).
  const missingKeys = (cfg?.missing ?? []).filter((m) => !(pasted && (m === 'pin' || m === 'totpSecret' || m === 'apiSecret')));
  const missing = missingKeys.map(labelOf);
  const canConnect = Boolean(cfg?.consentAt) && missingKeys.length === 0 && Boolean(cfg) && !dirty;
  const connected = account?.status === 'CONNECTED' && account.tokenStatus === 'ACTIVE';

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-6 text-sm">
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">Broker</span>
            {account ? <StatusBadge value={connected ? 'CONNECTED' : account.status} /> : <StatusBadge value="DISCONNECTED" label="Not connected" />}
            {account?.brokerClientId ? <span className="font-mono text-xs">{account.brokerClientId}</span> : null}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">Proxy</span>
            {cfg?.lastTest ? (
              cfg.lastTest.ok ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="size-4" /> OK · {cfg.lastTest.ip}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <XCircle className="size-4" /> Failed
                </span>
              )
            ) : (
              <span className="text-muted-foreground">Not tested</span>
            )}
          </span>
          {cfg?.lastLogin.at ? <span className="text-muted-foreground">Last login {formatDateTime(cfg.lastLogin.at)}</span> : null}
          {cfg?.lastLogin.error ? <span className="text-destructive">Last error: {cfg.lastLogin.error}</span> : null}
        </CardContent>
      </Card>

      <SetupSteps meta={meta} cfg={cfg} />

      <Card>
        <CardHeader>
          <CardTitle>{meta.name} API</CardTitle>
          <CardDescription>Your credentials are encrypted and never shown again — not even to the admin. Leave a saved field blank to keep it.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              doSave();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {meta.fields.map((fld) => (
                <F
                  key={fld.key}
                  id={`${broker}-${fld.key}`}
                  label={fld.label}
                  required={fld.required}
                  secret={fld.secret}
                  saved={fld.key === 'clientCode' ? undefined : cfg?.saved[fld.key as keyof BrokerApiConfigView['saved']]}
                  value={f[fld.key]}
                  onChange={set(fld.key)}
                  inputMode={fld.numeric ? 'numeric' : undefined}
                  hint={fld.hint}
                />
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <F id={`${broker}-host`} label="Static IP" required value={f.proxyHost} onChange={set('proxyHost')} hint="Proxy IP, e.g. 151.245.182.35 — or paste 151.245.182.35:443 and the port is filled for you" />
              <F id={`${broker}-port`} label="Port" required value={f.proxyPort} onChange={set('proxyPort')} inputMode="numeric" type="text" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <F id={`${broker}-pu`} label="Proxy Login ID" secret saved={cfg?.saved.proxyUser} value={f.proxyUser} onChange={set('proxyUser')} />
              <F id={`${broker}-pp`} label="Proxy Password" secret saved={cfg?.saved.proxyPass} value={f.proxyPass} onChange={set('proxyPass')} />
            </div>

            {meta.token ? (
              <F
                id={`${broker}-token`}
                label={meta.token}
                secret
                value={accessToken}
                onChange={setAccessToken}
                hint="Paste a token generated by the broker to connect directly. It is used once to connect and not kept in this form."
              />
            ) : null}
            {meta.autoLogin ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={autoLogin} onChange={(e) => setAutoLogin(e.target.checked)} />
                <span>
                  <strong>{meta.autoLogin}</strong>
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I authorise this platform to store my broker API credentials (encrypted) and to log in and place copy-trading orders in my account through my
                static IP.
              </span>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div>
                <p className="font-medium">Static IP proxy health</p>
                <p className="text-sm text-muted-foreground">
                  {cfg?.lastTest
                    ? cfg.lastTest.ok
                      ? `Working — brokers will see ${cfg.lastTest.ip}${cfg.latencyMs ? ` · ${cfg.latencyMs} ms` : ''} · ${formatDateTime(cfg.lastTest.at)}`
                      : (cfg.lastTest.error ?? 'Failed')
                    : 'Save, then test that the proxy works and which IP the broker will see.'}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={test.isPending || !cfg?.proxyHost || dirty}
                onClick={() =>
                  test.mutate(undefined, {
                    onSuccess: (v) => (v.lastTest?.ok ? toast.success(`Proxy OK — ${v.lastTest.ip}`) : toast.error(v.lastTest?.error ?? 'Proxy test failed')),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <Activity /> {test.isPending ? 'Testing…' : 'Test proxy health'}
              </Button>
            </div>

            <div className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <p className="font-medium">Important</p>
                <p className="text-muted-foreground">
                  {meta.daily} Orders are only accepted from the static IP registered with your broker.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="outline" disabled={save.isPending}>
                <ShieldCheck /> {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" disabled={!canConnect || connect.isPending} onClick={doConnect}>
                <Link2 /> {connect.isPending ? 'Connecting…' : connected ? 'Reconnect Broker' : 'Connect Broker'}
              </Button>
              <span className={cn('text-xs', canConnect ? 'text-muted-foreground' : 'text-warning')}>
                {dirty
                  ? 'Save your changes first'
                  : missing.length
                    ? `Missing: ${missing.join(', ')}`
                    : !cfg?.consentAt
                      ? 'Accept the consent and save'
                      : pasted
                        ? 'Connects instantly with your access token'
                        : meta.browserLogin
                          ? `Opens the ${meta.name} login page`
                          : 'Connects instantly (server-side login)'}
              </span>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BrokerApiPage() {
  const { data: me } = useMe();
  // A master's broker is for live market data only, which comes from Angel One.
  const isMaster = me?.role === 'MASTER';
  const brokers = isMaster ? BROKERS.filter((b) => b.slug === 'angel-one') : BROKERS;
  const [tab, setTab] = useState<BrokerSlug>('angel-one');
  // /broker-api?broker=upstox opens that tab (e.g. from "Reconnect" on the broker card).
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('broker') as BrokerSlug | null;
    if (b && META[b] && !isMaster) setTab(b);
    if (isMaster) setTab('angel-one');
  }, [isMaster]);
  return (
    <>
      <PageHeader
        title="Broker API"
        description={
          isMaster
            ? 'Connect your own Angel One API app for live market data (it never places orders). Your keys are private to you.'
            : 'Connect your own broker API app through your static IP — required for live auto trading.'
        }
      />
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg border p-1" role="tablist" aria-label="Broker">
        {brokers.map((b) => (
          <button
            key={b.slug}
            type="button"
            role="tab"
            aria-selected={tab === b.slug}
            onClick={() => setTab(b.slug)}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', tab === b.slug ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            {b.name}
          </button>
        ))}
      </div>
      <BrokerForm key={tab} broker={tab} />
    </>
  );
}
