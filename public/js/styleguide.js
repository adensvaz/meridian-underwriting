// Styleguide behaviour.
//
// Extracted from an inline <script> because the product ships
// `Content-Security-Policy: script-src self; style-src self`, which silently
// blocked it — the theme toggle did nothing and the colour swatches rendered
// empty. A dead design-system reference is worse than none, because it is the
// page a developer opens to learn the system.
//
// The style="" attributes that lived here are now real classes in
// /css/styleguide.css, because style-src self blocks inline styles and CSSOM
// style writes alike.

import { attachHelp } from './tooltip.js';

(() => {
  'use strict';

  /* ---- theme toggle ------------------------------------------------- */
  const root = document.documentElement;
  const bDark = document.getElementById('theme-dark');
  const bLight = document.getElementById('theme-light');
  const setTheme = (t) => {
    root.setAttribute('data-theme', t);
    bDark.setAttribute('aria-pressed', String(t === 'dark'));
    bLight.setAttribute('aria-pressed', String(t === 'light'));
  };
  bDark.addEventListener('click', () => setTheme('dark'));
  bLight.addEventListener('click', () => setTheme('light'));

  /* ---- swatch board ------------------------------------------------- */
  const swatches = {
    'sw-ground': ['bg-000', 'bg-100', 'bg-200', 'bg-300', 'bg-400'],
    'sw-struct': ['hairline', 'hairline-strong', 'hairline-glint'],
    'sw-text': ['text-1', 'text-2', 'text-3', 'text-4'],
    'sw-sem': ['accent', 'accent-bright', 'accent-tint', 'pos', 'cau', 'neg', 'neu']
  };
  const paint = () => {
    const cs = getComputedStyle(root);
    for (const [id, names] of Object.entries(swatches)) {
      const host = document.getElementById(id);
      host.textContent = '';
      for (const n of names) {
        const val = cs.getPropertyValue('--' + n).trim();
        const el = document.createElement('div');
        el.className = 'plate';
        el.style.padding = '0';
        el.style.overflow = 'hidden';
        const chip = document.createElement('div');
        chip.style.blockSize = '56px';
        chip.style.background = 'var(--' + n + ')';
        chip.style.borderBlockEnd = '1px solid var(--hairline)';
        const meta = document.createElement('div');
        meta.style.padding = '8px 10px';
        meta.innerHTML = '<div class="t-micro c-2">--' + n + '</div>' +
                         '<div class="t-micro c-4" style="margin-block-start:3px">' + val + '</div>';
        el.append(chip, meta);
        host.append(el);
      }
    }
  };
  paint();
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---- CSS count-up: swap to the formatted string on animationend ---- */
  const band = document.getElementById('kpi-band');
  const COUNT_MS = 640;
  const runCount = () => {
    band.querySelectorAll('.kpi').forEach((k, i) => {
      k.classList.remove('kpi--in');
      void k.offsetWidth;
      k.classList.add('kpi--in');
      // Belt and braces: if the tab is throttled and animationend never
      // arrives, the settled figure must still appear. A number is never
      // allowed to be stuck mid-roll.
      clearTimeout(k.__t);
      k.__t = setTimeout(() => k.classList.remove('kpi--in'), COUNT_MS + i * 60 + 160);
    });
  };
  band.addEventListener('animationend', (e) => {
    if (e.animationName === 'count') e.target.closest('.kpi')?.classList.remove('kpi--in');
  });
  document.getElementById('replay-count').addEventListener('click', runCount);

  /* ---- gauges: set the needle after paint so the 700ms sweep is seen - */
  const seatNeedles = (jitter) => {
    document.querySelectorAll('.gauge__needle').forEach((n) => {
      const base = parseFloat(n.dataset.deg);
      const d = jitter ? base + (Math.random() * 40 - 20) : base;
      n.style.setProperty('--deg', d.toFixed(2));
    });
  };
  document.getElementById('needle-stress').addEventListener('click', () => {
    seatNeedles(true);
    setTimeout(() => seatNeedles(false), 900);
  });

  /* ---- table density ------------------------------------------------ */
  const wrap = document.getElementById('rentroll');
  document.getElementById('density').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    wrap.dataset.density = b.dataset.d;
    b.parentElement.querySelectorAll('button')
      .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  /* ---- user edit: flash the cell, never animate the number ---------- */
  const cell = document.getElementById('edit-target');
  document.getElementById('edit-cell').addEventListener('click', () => {
    cell.innerHTML = '769 <span class="sqm">71.4</span>';
    cell.classList.remove('cell--flash'); void cell.offsetWidth;
    cell.classList.add('cell--flash');
  });

  const fieldRow = document.getElementById('field-commit');
  document.getElementById('commit-flash').addEventListener('click', () => {
    fieldRow.classList.remove('field--committed'); void fieldRow.offsetWidth;
    fieldRow.classList.add('field--committed');
  });

  /* ---- flags: replay the margin rules ------------------------------- */
  const replayFlags = () => {
    document.querySelectorAll('.flag').forEach((f) => {
      f.classList.remove('flag--in'); void f.offsetWidth; f.classList.add('flag--in');
    });
  };
  document.getElementById('replay-flags').addEventListener('click', replayFlags);

  /* ---- auth plate draw-in ------------------------------------------- */
  const plate = document.getElementById('auth-plate');
  document.getElementById('replay-auth').addEventListener('click', () => {
    const c = plate.cloneNode(true);
    plate.replaceWith(c);
    c.id = 'auth-plate';
  });

  /* ---- the extraction sequence -------------------------------------- */
  const ex = document.getElementById('extract');
  const pct = document.getElementById('ex-pct');
  const pageNo = document.getElementById('ex-page');
  const FLOOR = 4200;
  let tick = null;

  const runExtract = () => {
    clearInterval(tick);
    ex.classList.remove('ex--run');
    void ex.offsetWidth;
    ex.classList.add('ex--run');
    const t0 = performance.now();
    pageNo.textContent = 'Page 14 / 24';
    tick = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / FLOOR);
      pct.textContent = String(Math.round(p * 100)).padStart(3, '0') + '%';
      if (p >= 1) { clearInterval(tick); pageNo.textContent = 'Page 24 / 24'; }
    }, 60);
  };
  document.getElementById('run-extract').addEventListener('click', runExtract);

  /* ---- help --------------------------------------------------------- */
  // The specimen for the help affordance is the labels that were already on
  // this page, not a new swatch board: the whole point of the component is
  // that it adds nothing at rest. In the product these strings arrive on
  // ComputedValue.help and InputDef.help; here they are lifted verbatim from
  // the shipped dubai-residential models so the specimen cannot drift into
  // prose that no model actually ships.
  const HELP = {
    'Purchase price': 'Agreed purchase price before any acquisition costs. This is the number on the Form F / MOU, not the all-in cost — DLD and agency fees are added separately below.',
    'Gross yield': 'Annual rent divided by purchase price. Analytically crude — it ignores service charge, vacancy and the 4% DLD fee entirely — but it is the dominant local vernacular and every counterparty will quote it, so it is shown first.',
    'Net yield': 'NOI over all-in cost. The honest number: it carries the service charge, vacancy, irrecoverable VAT and the 4% DLD fee. Expect 150-250bps below the gross yield a broker will quote.',
    DSCR: 'NOI over debt service. UAE banks underwrite to 1.25x minimum on an investment mortgage; below that the facility is resized or declined.',
    'Contracted rent': 'Annual rent as a lump sum, the way Dubai quotes it — the headline figure on the Ejari tenancy contract. Summed across units from the rent roll when one is uploaded. Use the in-place contract rent if tenanted, or the achievable market rent if vacant.',
    'Service charge': 'Mollak-approved Owners Association budget per sqft per year, before VAT. This is a landlord cost in residential and is not recoverable from the tenant. Typical: apartment 10-25, villa 3-8. It is the dominant OpEx line in almost every Dubai residential deal.'
  };

  // A label with help becomes a real button in the tab order. A label without
  // it is left exactly as it was — no button, no underline, no listener.
  for (const label of document.querySelectorAll('.kpi__label, .field .field__label')) {
    const help = HELP[label.textContent.trim()];
    if (!help) continue;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `${label.className} tip`;
    trigger.textContent = label.textContent;
    attachHelp(trigger, help);
    label.replaceWith(trigger);
  }

  /* ---- first paint: seat needles, roll the KPIs, score the flags ----- */
  requestAnimationFrame(() => {
    seatNeedles(false);
    runCount();
    replayFlags();
    runExtract();
  });
})();
