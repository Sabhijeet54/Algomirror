/** Site behaviour: mobile menu, header state, reveals, the hero router and the enquiry form. One clock: GSAP. */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initForm } from './form';

gsap.registerPlugin(ScrollTrigger);
const motion = document.documentElement.classList.contains('motion');
const EASE = 'power3.out';

/* ---------------- mobile menu ---------------- */
const menuBtn = document.querySelector<HTMLButtonElement>('[data-menu]');
const mnav = document.getElementById('mnav');
menuBtn?.addEventListener('click', () => {
  const open = menuBtn.getAttribute('aria-expanded') !== 'true';
  menuBtn.setAttribute('aria-expanded', String(open));
  if (mnav) mnav.hidden = !open;
  document.documentElement.classList.toggle('menu-open', open);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuBtn?.getAttribute('aria-expanded') === 'true') menuBtn.click();
});

/* ---------------- header: solid once the page moves ---------------- */
const top = document.querySelector('[data-top]');
if (top) {
  const stick = () => top.classList.toggle('is-stuck', window.scrollY > 8);
  ScrollTrigger.create({ start: 0, end: 'max', onUpdate: stick, onRefresh: stick });
  stick();
}

/* ---------------- hero intro + reveals ---------------- */
if (motion) {
  const intro = gsap.utils.toArray<HTMLElement>('[data-intro]');
  if (intro.length) gsap.from(intro, { yPercent: 40, opacity: 0, duration: 0.9, ease: EASE, stagger: 0.07, delay: 0.05 });

  gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((el) => {
    const kids = el.hasAttribute('data-stagger') ? Array.from(el.children) : [el];
    gsap.from(kids, {
      y: 28,
      opacity: 0,
      duration: 0.8,
      ease: EASE,
      stagger: 0.05,
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    });
  });

  // Route lines in "how it works" draw as the section arrives.
  gsap.utils.toArray<SVGPathElement>('[data-draw]').forEach((p) => {
    const len = p.getTotalLength();
    gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.4, ease: 'power2.inOut', scrollTrigger: { trigger: p, start: 'top 85%', once: true } });
  });
}

/* ---------------- hero router: packets travel, rows fill ---------------- */
function router(root: HTMLElement) {
  const lines = Array.from(root.querySelectorAll<SVGPathElement>('[data-line]'));
  const rows = Array.from(root.querySelectorAll<SVGGElement>('[data-row]'));
  const layer = root.querySelector<SVGGElement>('[data-packets]');
  if (!lines.length || !layer || !motion) return;

  const NS = 'http://www.w3.org/2000/svg';
  const lens = lines.map((l) => l.getTotalLength());
  const dots = lines.map(() => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '4.5');
    c.setAttribute('class', 'router__packet');
    c.setAttribute('opacity', '0');
    layer.appendChild(c);
    return c;
  });
  const setStatus = (i: number, filled: boolean) => {
    const st = rows[i].querySelector('[data-st]');
    if (st) st.textContent = filled ? 'FILLED' : 'QUEUED';
    rows[i].classList.toggle('is-filled', filled);
  };

  const order = lines.map((_, i) => i).sort(() => Math.random() - 0.5);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6, paused: true });
  tl.call(() => rows.forEach((_, i) => setStatus(i, false)));
  tl.fromTo('[data-router] .router__dot', { scale: 1 }, { scale: 1.9, transformOrigin: '50% 50%', duration: 0.25, yoyo: true, repeat: 1, ease: 'power2.out' });
  order.forEach((i, k) => {
    const p = { t: 0 };
    const at = 0.35 + k * 0.09;
    tl.set(dots[i], { attr: { opacity: 1 } }, at);
    tl.to(
      p,
      {
        t: 1,
        duration: 1.05,
        ease: 'power2.inOut',
        onUpdate: () => {
          const pt = lines[i].getPointAtLength(p.t * lens[i]);
          dots[i].setAttribute('cx', String(pt.x));
          dots[i].setAttribute('cy', String(pt.y));
        },
        onComplete: () => {
          dots[i].setAttribute('opacity', '0');
          setStatus(i, true);
        },
      },
      at,
    );
  });
  tl.to({}, { duration: 2.4 });

  // Start with every row filled (the best first frame), then begin routing.
  rows.forEach((_, i) => setStatus(i, true));
  ScrollTrigger.create({ trigger: root, start: 'top bottom', end: 'bottom top', onToggle: (s) => (s.isActive ? tl.play() : tl.pause()) });
  gsap.delayedCall(1.2, () => ScrollTrigger.refresh());
}
document.querySelectorAll<HTMLElement>('[data-router]').forEach(router);

/* ---------------- forms ---------------- */
document.querySelectorAll<HTMLFormElement>('[data-enquiry]').forEach(initForm);
