/** Enquiry form: client / partner switch, prefill from the URL, checks, and the post to the platform API. */

type Kind = 'CLIENT' | 'PARTNER';

const MESSAGES: Record<string, string> = {
  name: 'Please enter your name.',
  email: 'Please enter a valid email.',
  phone: 'Please enter a 10 digit mobile number.',
  interest: 'Please choose what you are looking for.',
  partnerInterest: 'Please choose white label or custom development.',
};

export function initForm(form: HTMLFormElement) {
  const sent = form.parentElement?.querySelector<HTMLElement>('[data-sent]');
  const status = form.querySelector<HTMLElement>('[data-status]')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
  const kindInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="kind"]'));
  const partnerInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="partnerInterest"]'));

  const kind = (): Kind => (kindInputs.find((i) => i.checked)?.value as Kind) ?? 'CLIENT';
  const partnerInterest = () => partnerInputs.find((i) => i.checked)?.value ?? '';

  /** Shows the fields of the chosen kind; hidden fields are disabled so they are neither checked nor sent. */
  function sync() {
    const k = kind();
    const custom = k === 'PARTNER' && partnerInterest() === 'CUSTOM_DEVELOPMENT';
    form.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
      const show = el.dataset.for === k || (el.dataset.for === 'CUSTOM' && custom);
      el.hidden = !show;
      el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea').forEach((f) => (f.disabled = !show));
    });
  }

  // Prefill: /contact/?type=partner&interest=CUSTOM_DEVELOPMENT&modules=MOBILE_APP,BACKTESTING
  const q = new URLSearchParams(location.search);
  const type = (q.get('type') ?? '').toUpperCase();
  if (type === 'PARTNER' || type === 'CLIENT') kindInputs.forEach((i) => (i.checked = i.value === type));
  const interest = (q.get('interest') ?? '').toUpperCase();
  if (interest) {
    partnerInputs.forEach((i) => (i.checked = i.value === interest));
    const sel = form.querySelector<HTMLSelectElement>('[data-interest-client]');
    if (sel && Array.from(sel.options).some((o) => o.value === interest)) sel.value = interest;
  }
  const PLANS: Record<string, string> = { MONTHLY: 'Monthly (₹24,999)', QUARTERLY: 'Quarterly (₹64,999)', HALF_YEARLY: 'Half-yearly (₹1,09,999)', YEARLY: 'Yearly (₹1,51,000)' };
  const plan = PLANS[(q.get('plan') ?? '').toUpperCase()];
  const msg = form.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  if (plan && msg && !msg.value) msg.value = `I would like the ${plan} plan.`;
  const mods = new Set((q.get('modules') ?? '').toUpperCase().split(',').filter(Boolean));
  form.querySelectorAll<HTMLInputElement>('input[name="modules"]').forEach((c) => (c.checked = mods.has(c.value)));

  form.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'kind' || t.name === 'partnerInterest') sync();
    t.closest('.fld, .pick')?.classList.remove('is-bad');
  });
  sync();

  function bad(name: string) {
    const field = form.querySelector<HTMLElement>(`[name="${name}"]`);
    const wrap = field?.closest<HTMLElement>('.fld, .pick');
    wrap?.classList.add('is-bad');
    field?.focus();
    status.textContent = MESSAGES[name] ?? 'Please check the form.';
    status.dataset.tone = 'bad';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const val = (k: string) => String(fd.get(k) ?? '').trim();
    const k = kind();
    form.querySelectorAll('.is-bad').forEach((el) => el.classList.remove('is-bad'));

    if (val('name').length < 2) return bad('name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email'))) return bad('email');
    if (!/^\+?\d{10,15}$/.test(val('phone').replace(/[\s()-]/g, ''))) return bad('phone');
    if (k === 'CLIENT' && !val('interest')) return bad('interest');
    if (k === 'PARTNER' && !partnerInterest()) return bad('partnerInterest');

    const body = {
      kind: k,
      name: val('name'),
      email: val('email'),
      phone: val('phone'),
      city: val('city'),
      company: k === 'PARTNER' ? val('company') : '',
      interest: k === 'CLIENT' ? val('interest') : partnerInterest(),
      partnerType: val('partnerType'),
      clients: val('clients'),
      modules: fd.getAll('modules').map(String),
      message: val('message'),
      website: val('website'),
      page: location.pathname + location.search,
    };

    submit.disabled = true;
    status.dataset.tone = '';
    status.textContent = 'Sending…';
    try {
      // text/plain keeps this a simple cross-site request (no preflight); the API reads the JSON text.
      const res = await fetch(form.dataset.api!, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const msg = Array.isArray(err?.message) ? err.message[0] : err?.message;
        throw new Error(res.status === 429 ? 'Too many tries. Please wait a few minutes and send again.' : msg || 'Could not send. Please try again.');
      }
      if (sent) {
        const t = sent.querySelector('[data-sent-text]');
        if (t && k === 'PARTNER') t.textContent = 'Our partnerships team will call or email you within one working day.';
        form.hidden = true;
        sent.hidden = false;
        sent.focus();
      }
    } catch (err) {
      status.dataset.tone = 'bad';
      status.textContent = err instanceof TypeError ? 'Network problem. Check your connection and try again.' : (err as Error).message;
    } finally {
      submit.disabled = false;
    }
  });
}
